/**
 * PROTOTYPE — throwaway. Sketch B2: TypeScript, plain-function form.
 *
 * The user's workflow *is* a function. T3 hands it an API and gets back a
 * result.
 *
 * The punchline of the whole exercise: **this is the spike, with the Effect
 * stripped out.** `WorkflowRunner.ts` at 6fcca9e63 is already exactly this
 * shape — plan, implement, a bounded `for` loop around test/review/fix, early
 * returns for each failure kind. Every other format in this prototype is an
 * attempt to buy inspectability, safety or editability by giving up the
 * expressiveness this form has for free.
 */
import { lastStandaloneLine } from "../runtime.ts";

export interface WorkflowApi {
  readonly inputs: { readonly task: string; readonly testCommand: string };
  /** Throws `WorkflowAbort` on infrastructure failure. */
  readonly agent: (name: string, prompt: string) => Promise<string>;
  /** Returns the output; a nonzero exit is a value, not a throw. */
  readonly command: (
    name: string,
    command: string,
  ) => Promise<{ status: "success" | "commandFailed"; output: string }>;
}

export class WorkflowAbort extends Error {}

export interface FunctionResult {
  readonly status: "passed" | "failed";
  readonly failure: string | null;
}

export const workflow = async (api: WorkflowApi): Promise<FunctionResult> => {
  const { task, testCommand } = api.inputs;

  const plan = await api.agent(
    "plan",
    `You are the Plan node of an automated T3 workflow.

## Task

${task}

## Instructions

Write a short, concrete implementation plan. Do not modify any files.`,
  );

  const implement = await api.agent(
    "implement",
    `You are the Implement node of an automated T3 workflow.

## Plan

${plan}

## Instructions

Apply the plan in this worktree, then summarise what you changed.`,
  );

  let fix = "";

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const test = await api.command("test", testCommand);

    const review = await api.agent(
      "review",
      [
        `You are the Review node of an automated T3 workflow (attempt ${attempt}).`,
        `## Plan\n\n${plan}`,
        `## Implementation report\n\n${implement}`,
        attempt > 1 ? `## Latest fix report\n\n${fix}` : "",
        `## Latest test run\n\n${test.output}`,
        "## Instructions\n\nDecide whether the work satisfies the task. Explain briefly.\nFinish your reply with a final line containing exactly PASS or FAIL and nothing else.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );

    const verdict = lastStandaloneLine(review);
    if (verdict === "pass") return { status: "passed", failure: null };
    if (verdict === "unreadable") return { status: "failed", failure: "review-verdict-unreadable" };
    if (attempt === 3) return { status: "failed", failure: "review-retry-limit" };

    fix = await api.agent(
      "fix",
      `You are the Fix node of an automated T3 workflow (attempt ${attempt}).

## Review feedback

${review}

## Latest test run

${test.output}

## Instructions

Address every point in the review feedback and the failing test output.`,
    );
  }

  return { status: "failed", failure: "review-retry-limit" };
};

// ── Where this form strains ───────────────────────────────────────────────────
//
// ⚠ (15) **Durability is the whole ballgame, and this is where the format
//     decision actually gets made.** The destination requires runs that
//     *survive restarts*. A static document checkpoints trivially: "we are at
//     node `review`, attempt 2" is a row. A function has no such position —
//     the state is a program counter and a closure. Surviving a restart means
//     either replaying it deterministically (every `await api.agent()`
//     memoized, and all other side effects banned — the Temporal/DBOS
//     bargain), or capturing continuations. Both are large, and both constrain
//     what the user may write inside their own function. This lands squarely
//     on the durability ticket, and it is the strongest reason the two
//     decisions cannot be made independently.
//
// ⚠ (16) **Nothing can be known before running it.** Not the node list, not
//     the graph, not "3 of 7 steps done". A pre-run progress list — the
//     obvious shape for watching a run — is unavailable in principle, not just
//     unimplemented. Two versions of a workflow cannot be meaningfully diffed
//     either.
//
// ⚠ (17) **Arbitrary code execution on the server**, same as B1 but with no
//     ceiling at all: the user's function can read the filesystem, open
//     sockets, or run forever.
//
// ⚠ (18) **`for (let attempt = 1; attempt <= 3; …)`** — the retry bound is a
//     literal in user code. T3 cannot enforce a ceiling, cost limit, or
//     timeout by inspecting the definition; it can only enforce them from
//     outside, at runtime.
//
// What it makes easy: everything about control flow. The three-valued verdict
// is an `if`/`if`/`if`. Infrastructure failure is an exception and unwinds
// ambiently — no format needed to express it, which is why every other sketch
// left it implicit. There is no expressiveness ceiling, so no feature request
// can ever be "the schema cannot say that".
