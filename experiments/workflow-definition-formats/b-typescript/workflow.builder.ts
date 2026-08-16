/**
 * PROTOTYPE — throwaway. Sketch B1: TypeScript, typed-builder form.
 *
 * The same workflow again, authored as typed TS the user writes and T3 loads.
 *
 * The structural finding is at the bottom of this file: **the builder is a
 * typed front-end for the declarative format.** `build()` emits the very same
 * transition-table document sketch A1 hand-writes, and the dry-run executes it
 * with the same interpreter. So "TypeScript vs YAML" is not a choice of
 * execution model — it is a choice of *authoring surface* over one model.
 *
 * With one exception, and it is the interesting one: the prompts come out as
 * **closures**, not strings. That part does not serialize.
 */
import type { NodeDef, Target, WorkflowDoc } from "../runtime.ts";

interface Inputs {
  readonly task: string;
  readonly testCommand: string;
}

/** `latest` is keyed by the nodes declared *so far*, so a typo is a type error. */
interface Scope<Names extends string> {
  readonly inputs: Inputs;
  readonly attempt: number;
  readonly latest: Readonly<Record<Names, string>>;
}

type Prompt<Names extends string> = (scope: Scope<Names>) => string;

interface Step {
  readonly name: string;
  readonly def: (next: Target) => NodeDef;
}

class Block<Names extends string = never> {
  readonly steps: ReadonlyArray<Step>;

  constructor(steps: ReadonlyArray<Step> = []) {
    this.steps = steps;
  }

  agent<N extends string>(name: N, prompt: Prompt<Names>): Block<Names | N> {
    return new Block([
      ...this.steps,
      {
        name,
        def: (next) => ({
          type: "agent",
          prompt: prompt as NodeDef["prompt"],
          on: { success: next },
        }),
      },
    ]);
  }

  command<N extends string>(name: N, command: (inputs: Inputs) => string): Block<Names | N> {
    return new Block([
      ...this.steps,
      {
        name,
        def: (next) => ({
          type: "command",
          command: command({ task: "", testCommand: "{{ inputs.testCommand }}" }),
          // A nonzero exit is a domain result — the builder makes this the
          // default rather than something the user must remember, which is one
          // small win over the YAML forms.
          on: { success: next, commandFailed: next },
        }),
      },
    ]);
  }

  review<N extends string>(
    name: N,
    prompt: Prompt<Names>,
    options: { readonly onUnreadable: string },
  ): Block<Names | N> {
    return new Block([
      ...this.steps,
      {
        name,
        def: (next) => ({
          type: "agent",
          prompt: prompt as NodeDef["prompt"],
          verdict: { reader: "lastStandaloneLine", onUnreadable: options.onUnreadable },
          on: { pass: { end: "passed" }, fail: next },
        }),
      },
    ]);
  }
}

class WorkflowBuilder<Names extends string = never> {
  readonly head: ReadonlyArray<Step>;
  readonly loop: { readonly maxAttempts: number; readonly steps: ReadonlyArray<Step> } | null;

  constructor(
    head: ReadonlyArray<Step> = [],
    loop: { readonly maxAttempts: number; readonly steps: ReadonlyArray<Step> } | null = null,
  ) {
    this.head = head;
    this.loop = loop;
  }

  agent<N extends string>(name: N, prompt: Prompt<Names>): WorkflowBuilder<Names | N> {
    return new WorkflowBuilder(
      [
        ...this.head,
        {
          name,
          def: (next) => ({
            type: "agent",
            prompt: prompt as NodeDef["prompt"],
            on: { success: next },
          }),
        },
      ],
      this.loop,
    );
  }

  /** The bound sits on the cycle, as in A2 — not in a global settings block. */
  retry<B extends string>(
    options: { readonly maxAttempts: number },
    build: (block: Block<Names>) => Block<Names | B>,
  ): WorkflowBuilder<Names | B> {
    return new WorkflowBuilder(this.head, {
      maxAttempts: options.maxAttempts,
      steps: build(new Block()).steps,
    });
  }

  build(name: string): WorkflowDoc {
    const loop = this.loop ?? { maxAttempts: 1, steps: [] };
    const all = [...this.head, ...loop.steps];
    const nodes: Record<string, NodeDef> = {};

    this.head.forEach((step, index) => {
      const next = this.head[index + 1]?.name ?? loop.steps[0]?.name ?? "";
      nodes[step.name] = step.def(next);
    });
    loop.steps.forEach((step, index) => {
      // The last step of the block loops back to its first: the back-edge is
      // generated, so the author never writes it and never gets it wrong.
      nodes[step.name] = step.def(loop.steps[index + 1]?.name ?? loop.steps[0]?.name ?? "");
    });

    return {
      name,
      settings: { maxReviewAttempts: loop.maxAttempts },
      start: all[0]?.name ?? "",
      nodes,
    };
  }
}

// ── The workflow ──────────────────────────────────────────────────────────────

export const workflow = new WorkflowBuilder()
  .agent(
    "plan",
    ({ inputs }) => `You are the Plan node of an automated T3 workflow.

## Task

${inputs.task}

## Instructions

Write a short, concrete implementation plan. Do not modify any files.`,
  )
  .agent(
    "implement",
    ({ latest }) => `You are the Implement node of an automated T3 workflow.

## Plan

${latest.plan}

## Instructions

Apply the plan in this worktree, then summarise what you changed.`,
  )
  .retry({ maxAttempts: 3 }, (block) =>
    block
      .command("test", (inputs) => inputs.testCommand)
      .review(
        "review",
        ({ latest, attempt }) =>
          [
            `You are the Review node of an automated T3 workflow (attempt ${attempt}).`,
            `## Plan\n\n${latest.plan}`,
            `## Implementation report\n\n${latest.implement}`,
            // ⚠ (4) from the YAML sketches — the conditional section — is a
            // ternary. The entire `{{#if}}` template language disappears, and
            // with it the need to specify truthiness, missing-key behaviour
            // and whitespace rules. This is the largest single difference
            // between the data formats and the TypeScript ones.
            attempt > 1 ? `## Latest fix report\n\n${latest.fix}` : "",
            `## Latest test run\n\n${latest.test}`,
            "## Instructions\n\nDecide whether the work satisfies the task. Explain briefly.\nFinish your reply with a final line containing exactly PASS or FAIL and nothing else.",
          ]
            .filter(Boolean)
            .join("\n\n"),
        { onUnreadable: "review-verdict-unreadable" },
      )
      .agent(
        "fix",
        ({
          latest,
          attempt,
        }) => `You are the Fix node of an automated T3 workflow (attempt ${attempt}).

## Review feedback

${latest.review}

## Latest test run

${latest.test}

## Instructions

Address every point in the review feedback and the failing test output.`,
      ),
  )
  .build("plan-implement-test-review");

// ── Where this form strains ───────────────────────────────────────────────────
//
// ⚠ (11) **The prompts do not serialize.** `build()` produces a document whose
//     graph is plain data but whose prompts are closures. So this definition
//     can be executed, but it cannot be stored as a record (sketch C), diffed
//     in a UI, or rendered in a form editor. The prompt is the part that
//     resists serialization — which is *why* the declarative forms needed a
//     template language at all. That is not a syntax difference; it is the
//     real seam between the two families.
//
// ⚠ (12) **User code runs on the T3 server, in the hot path.** Not just at
//     load: each prompt closure is invoked when its node runs, part-way
//     through a paid run. Loading the module means resolving the user's TS and
//     their imports. Sandboxing is a question neither data format raises.
//
// ⚠ (13) **Same expressiveness ceiling as A2.** `retry` exists because a
//     method exists. `if`, `parallel`, `while` do not. The types are better;
//     the ceiling is identical, because the builder is still producing a static
//     document. Only the plain-function form (B2) escapes it.
//
// ⚠ (14) **Non-TypeScript authors cannot produce this**, and neither can an
//     in-app editor.
//
// What it makes easy, and it is a lot: `latest.pln` is a compile error rather
// than an empty string discovered three paid agent turns into a run;
// autocomplete lists the upstream nodes; the verdict reader is an ordinary
// function that can be unit-tested; the back-edge is generated rather than
// hand-wired; prompt composition is just string handling.
