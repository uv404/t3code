/**
 * PROTOTYPE — throwaway. `workflow.transitions.yaml`, transcribed to a plain
 * object so the dry-run can load it without pulling a YAML parser into an
 * experiment. Same document, different syntax; the strain the sketch is about
 * is structural, not syntactic.
 *
 * Prompts are trimmed relative to the YAML — the shape is the point, not the
 * wording.
 */
import type { WorkflowDoc } from "../runtime.ts";

export const doc: WorkflowDoc = {
  name: "plan-implement-test-review",
  settings: { maxReviewAttempts: 3 },
  start: "plan",
  nodes: {
    plan: {
      type: "agent",
      prompt: [
        "You are the Plan node of an automated T3 workflow.",
        "",
        "## Task",
        "",
        "{{ inputs.task }}",
        "",
        "## Instructions",
        "",
        "Write a short, concrete implementation plan. Do not modify any files.",
      ].join("\n"),
      on: { success: "implement" },
    },

    implement: {
      type: "agent",
      prompt: [
        "You are the Implement node of an automated T3 workflow.",
        "",
        "## Plan",
        "",
        "{{ nodes.plan.latest.output }}",
        "",
        "## Instructions",
        "",
        "Apply the plan in this worktree, then summarise what you changed.",
      ].join("\n"),
      on: { success: "test" },
    },

    test: {
      type: "command",
      command: "{{ inputs.testCommand }}",
      // Both outcomes go to Review on purpose: a nonzero exit is a domain
      // result, and Review needs the failing output.
      on: { success: "review", commandFailed: "review" },
    },

    review: {
      type: "agent",
      prompt: [
        "You are the Review node of an automated T3 workflow (attempt {{ run.attempt }}).",
        "",
        "## Plan",
        "",
        "{{ nodes.plan.latest.output }}",
        "",
        "## Implementation report",
        "",
        "{{ nodes.implement.latest.output }}",
        "",
        "{{#if run.attempt > 1}}## Latest fix report",
        "",
        "{{ nodes.fix.latest.output }}",
        "{{/if}}",
        "## Latest test run",
        "",
        "{{ nodes.test.latest.output }}",
        "",
        "## Instructions",
        "",
        "Decide whether the work satisfies the task. Explain briefly.",
        "Finish your reply with a final line containing exactly PASS or FAIL and nothing else.",
      ].join("\n"),
      verdict: { reader: "lastStandaloneLine", onUnreadable: "review-verdict-unreadable" },
      on: { pass: { end: "passed" }, fail: "fix" },
    },

    fix: {
      type: "agent",
      prompt: [
        "You are the Fix node of an automated T3 workflow (attempt {{ run.attempt }}).",
        "",
        "## Review feedback",
        "",
        "{{ nodes.review.latest.output }}",
        "",
        "## Latest test run",
        "",
        "{{ nodes.test.latest.output }}",
        "",
        "## Instructions",
        "",
        "Address every point in the review feedback and the failing test output.",
      ].join("\n"),
      on: { success: "test" },
    },
  },
};
