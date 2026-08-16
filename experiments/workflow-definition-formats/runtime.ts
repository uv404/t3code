/**
 * PROTOTYPE — throwaway. Shared stub runtime for the format sketches.
 *
 * Nothing here talks to a provider. Node outcomes are scripted, so the same
 * scenario can be pushed through every candidate format and the executed path
 * compared. The point is to find out whether the formats express the *same*
 * workflow, and where an interpreter has to invent rules the format never
 * stated.
 *
 * No Effect, no error handling, no tests. Run it with `node dryRun.ts`.
 */

// ── Outcomes ──────────────────────────────────────────────────────────────────

/** `failure` is infrastructure: provider died, dispatch rejected, turn timed out. */
export type AgentOutcome =
  | { readonly status: "success"; readonly output: string }
  | { readonly status: "failure"; readonly detail: string };

/**
 * Three statuses, matching the spike's `CommandNode`:
 * `commandFailed` (nonzero exit) is a *domain* result and the run continues.
 */
export type CommandOutcome =
  | { readonly status: "success" | "commandFailed"; readonly output: string }
  | { readonly status: "failure"; readonly detail: string };

export type Verdict = "pass" | "fail" | "unreadable";

/** The spike's rule: last standalone PASS/FAIL line wins, else unreadable. */
export const lastStandaloneLine = (output: string): Verdict => {
  const lines = output.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "")
      .replaceAll(/[*_`#>\s]/g, "")
      .replace(/[.!:;,]+$/, "")
      .toUpperCase();
    if (line === "PASS") return "pass";
    if (line === "FAIL") return "fail";
  }
  return "unreadable";
};

// ── Scripted executor ─────────────────────────────────────────────────────────

/** Keyed `node#attempt`, e.g. `review#2`. `*` entries are the fallback for a node. */
export type Script = Record<string, AgentOutcome | CommandOutcome>;

export interface Scenario {
  readonly name: string;
  readonly script: Script;
}

export interface Executor {
  readonly agent: (node: string, attempt: number, prompt: string) => AgentOutcome;
  readonly command: (node: string, attempt: number, command: string) => CommandOutcome;
  readonly trace: ReadonlyArray<string>;
  /** Latest output per node, exactly like the spike's `latest(context, node)`. */
  readonly latest: Readonly<Record<string, string>>;
}

export const makeExecutor = (scenario: Scenario): Executor => {
  const trace: Array<string> = [];
  const latest: Record<string, string> = {};

  const lookup = (node: string, attempt: number) =>
    scenario.script[`${node}#${attempt}`] ??
    scenario.script[`${node}#*`] ?? { status: "success", output: "ok" };

  const record = (node: string, attempt: number, outcome: AgentOutcome | CommandOutcome) => {
    trace.push(`${node}#${attempt} → ${outcome.status}`);
    if (outcome.status !== "failure") latest[node] = outcome.output;
    return outcome;
  };

  return {
    trace,
    latest,
    agent: (node, attempt) => record(node, attempt, lookup(node, attempt)) as AgentOutcome,
    command: (node, attempt) => record(node, attempt, lookup(node, attempt)) as CommandOutcome,
  };
};

// ── The template mini-language (⚠ 4) ──────────────────────────────────────────

/**
 * Just enough of a template engine to render the declarative sketches.
 *
 * This function is itself a finding. Thirty lines in, it already needs a
 * comparison operator, a missing-key policy, and whitespace rules — none of
 * which the YAML document specifies. The TypeScript sketches delete it
 * entirely: a prompt there is a template literal and a ternary.
 */
export const render = (
  template: string,
  scope: {
    inputs: Record<string, string>;
    attempt: number;
    latest: Readonly<Record<string, string>>;
  },
): string => {
  const value = (path: string): string => {
    const parts = path.split(".");
    if (parts[0] === "inputs") return scope.inputs[parts[1] ?? ""] ?? "";
    if (parts[0] === "run" && parts[1] === "attempt") return String(scope.attempt);
    // `nodes.plan.latest.output` / `steps.plan.output`
    if (parts[0] === "nodes" || parts[0] === "steps") return scope.latest[parts[1] ?? ""] ?? "";
    return "";
  };

  return (
    template
      // Only ever needed one operator, and already had to pick its semantics.
      .replaceAll(
        /\{\{#if run\.attempt > (\d+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
        (_m, n: string, body: string) => (scope.attempt > Number(n) ? body : ""),
      )
      .replaceAll(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => value(path))
  );
};

// ── The A1 transition-table document ──────────────────────────────────────────

export type Target = string | { readonly end: "passed" } | { readonly failRun: string };

export type NodeDef =
  | {
      readonly type: "agent";
      /**
       * A string is a template (storable, diffable, renderable in an editor).
       * A function is a closure — which is what the TypeScript builder produces,
       * and it is exactly the part that cannot be serialized. See README.
       */
      readonly prompt:
        | string
        | ((scope: {
            inputs: Record<string, string>;
            attempt: number;
            latest: Readonly<Record<string, string>>;
          }) => string);
      readonly verdict?: { readonly reader: "lastStandaloneLine"; readonly onUnreadable: string };
      readonly on: Readonly<Record<string, Target>>;
    }
  | {
      readonly type: "command";
      readonly command: string;
      readonly on: Readonly<Record<string, Target>>;
    };

export interface WorkflowDoc {
  readonly name: string;
  readonly settings: { readonly maxReviewAttempts: number };
  readonly start: string;
  readonly nodes: Readonly<Record<string, NodeDef>>;
}

export interface RunResult {
  readonly status: "passed" | "failed";
  readonly failure: string | null;
  readonly trace: ReadonlyArray<string>;
}

/**
 * Interpret the A1 transition table.
 *
 * Two rules here are **invented by this interpreter**, not stated by the
 * document — which is the sketch's main structural finding:
 *
 * 1. *What "attempt" means.* The document writes `{{ run.attempt }}` but never
 *    defines it. This interpreter counts entries into the node. A different
 *    reading (attempts around the whole cycle) gives different prompts.
 * 2. *What `maxReviewAttempts` bounds.* The setting is global; the thing it
 *    bounds is a cycle. This interpreter hardcodes "the node that has a
 *    verdict" — fine for one cycle, meaningless for two.
 */
export const runTransitions = (
  doc: WorkflowDoc,
  inputs: Record<string, string>,
  exec: Executor,
): RunResult => {
  const entries: Record<string, number> = {};
  let current: string = doc.start;

  for (let guard = 0; guard < 100; guard += 1) {
    const node = doc.nodes[current];
    if (node === undefined)
      return { status: "failed", failure: `unknown node ${current}`, trace: exec.trace };

    const attempt = (entries[current] = (entries[current] ?? 0) + 1);
    let outcome: string;

    if (node.type === "command") {
      const result = exec.command(
        current,
        attempt,
        render(node.command, { inputs, attempt, latest: exec.latest }),
      );
      if (result.status === "failure") {
        return {
          status: "failed",
          failure: `command-node/${current}: ${result.detail}`,
          trace: exec.trace,
        };
      }
      outcome = result.status;
    } else {
      const prompt =
        typeof node.prompt === "string"
          ? render(node.prompt, { inputs, attempt, latest: exec.latest })
          : node.prompt({ inputs, attempt, latest: exec.latest });
      const result = exec.agent(current, attempt, prompt);
      if (result.status === "failure") {
        return {
          status: "failed",
          failure: `agent-node/${current}: ${result.detail}`,
          trace: exec.trace,
        };
      }

      if (node.verdict === undefined) {
        outcome = "success";
      } else {
        const verdict = lastStandaloneLine(result.output);
        if (verdict === "unreadable") {
          return { status: "failed", failure: node.verdict.onUnreadable, trace: exec.trace };
        }
        // Invented rule (2): the bound is applied here because this is the node
        // with a verdict, not because the document said so.
        if (verdict === "fail" && attempt >= doc.settings.maxReviewAttempts) {
          return { status: "failed", failure: "review-retry-limit", trace: exec.trace };
        }
        outcome = verdict;
      }
    }

    const target = node.on[outcome];
    if (target === undefined) {
      return { status: "failed", failure: `no edge for ${current}/${outcome}`, trace: exec.trace };
    }
    if (typeof target !== "string") {
      if ("end" in target) return { status: "passed", failure: null, trace: exec.trace };
      return { status: "failed", failure: target.failRun, trace: exec.trace };
    }
    current = target;
  }

  return { status: "failed", failure: "guard tripped", trace: exec.trace };
};

// ── Scenarios ─────────────────────────────────────────────────────────────────

const passing = "Looks good.\n\nPASS";
const failing = "Tests are red and the plan was not followed.\n\nFAIL";

export const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    name: "happy path — Review PASS on attempt 1",
    script: { "review#1": { status: "success", output: passing } },
  },
  {
    name: "retry — test fails, Review FAIL, Fix, then PASS",
    script: {
      "test#1": { status: "commandFailed", output: "1 failing\nexit 1" },
      "review#1": { status: "success", output: failing },
      "test#2": { status: "success", output: "all green\nexit 0" },
      "review#2": { status: "success", output: passing },
    },
  },
  {
    name: "retry limit — Review FAIL every time",
    script: { "review#*": { status: "success", output: failing } },
  },
  {
    name: "unreadable verdict — Review ignored the instruction",
    script: { "review#1": { status: "success", output: "Seems fine to me, ship it." } },
  },
  {
    name: "infrastructure failure — Implement turn times out",
    script: {
      "implement#1": {
        status: "failure",
        detail: "timeout: no terminal provider event within 60000ms",
      },
    },
  },
];
