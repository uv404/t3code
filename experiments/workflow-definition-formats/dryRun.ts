/**
 * PROTOTYPE — throwaway. Push every candidate format through the same scripted
 * scenarios and print the path each one actually executed.
 *
 *   node experiments/workflow-definition-formats/dryRun.ts
 *
 * If the formats are really the same workflow, the traces match. Where they do
 * not, the difference is a real expressiveness gap rather than an opinion.
 */
import { doc as transitionsDoc } from "./a-declarative/workflow.transitions.ts";
import { workflow as builderDoc } from "./b-typescript/workflow.builder.ts";
import { workflow as workflowFunction, WorkflowAbort } from "./b-typescript/workflow.function.ts";
import {
  makeExecutor,
  runTransitions,
  SCENARIOS,
  type RunResult,
  type Scenario,
} from "./runtime.ts";

const INPUTS = { task: "Add a --json flag to the export command", testCommand: "pnpm test" };

/** Drive the plain-function form through the same scripted executor. */
const runFunction = async (scenario: Scenario): Promise<RunResult> => {
  const exec = makeExecutor(scenario);
  const attempts: Record<string, number> = {};
  const next = (node: string) => (attempts[node] = (attempts[node] ?? 0) + 1);

  try {
    const result = await workflowFunction({
      inputs: INPUTS,
      agent: async (name, prompt) => {
        const outcome = exec.agent(name, next(name), prompt);
        if (outcome.status === "failure")
          throw new WorkflowAbort(`agent-node/${name}: ${outcome.detail}`);
        return outcome.output;
      },
      command: async (name, command) => {
        const outcome = exec.command(name, next(name), command);
        if (outcome.status === "failure")
          throw new WorkflowAbort(`command-node/${name}: ${outcome.detail}`);
        return outcome;
      },
    });
    return { status: result.status, failure: result.failure, trace: exec.trace };
  } catch (error) {
    return { status: "failed", failure: (error as Error).message, trace: exec.trace };
  }
};

const CANDIDATES: ReadonlyArray<{
  label: string;
  run: (scenario: Scenario) => Promise<RunResult>;
}> = [
  {
    label: "A1  declarative / transition table",
    run: async (scenario) => runTransitions(transitionsDoc, INPUTS, makeExecutor(scenario)),
  },
  {
    label: "B1  typescript / typed builder",
    // Same interpreter, same document shape — the builder only authored it.
    run: async (scenario) => runTransitions(builderDoc, INPUTS, makeExecutor(scenario)),
  },
  { label: "B2  typescript / plain function", run: runFunction },
];

const describe = (result: RunResult) =>
  `${result.status}${result.failure === null ? "" : ` (${result.failure})`}`;

for (const scenario of SCENARIOS) {
  console.log(`\n[1m── ${scenario.name}[0m`);

  const results: Array<RunResult> = [];
  for (const candidate of CANDIDATES) {
    const result = await candidate.run(scenario);
    results.push(result);
    console.log(`  ${candidate.label.padEnd(36)} ${describe(result)}`);
    console.log(`  ${" ".repeat(36)} ${result.trace.join("  ›  ") || "(no nodes ran)"}`);
  }

  const [first, ...rest] = results;
  const agree =
    first !== undefined &&
    rest.every(
      (other) =>
        other.status === first.status &&
        other.failure === first.failure &&
        other.trace.join("|") === first.trace.join("|"),
    );
  console.log(`  ${agree ? "[32m✓ all three formats agree[0m" : "[31m✗ formats diverge[0m"}`);
}

console.log(`
[1mWhat this run does not prove[0m
  Agreement here is agreement about *control flow only*. The prompts differ:
  A1 renders a template mini-language, B1 and B2 build strings in TypeScript.
  Prompt authoring is where the formats really diverge — see the README.
`);
