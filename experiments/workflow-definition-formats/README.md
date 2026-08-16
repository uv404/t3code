# Candidate workflow definition formats

**PROTOTYPE — throwaway.** Built for
[Sketch candidate workflow definition formats](https://github.com/uv404/t3code/issues/9),
a ticket on [Map: T3 Workflows as a shippable feature](https://github.com/uv404/t3code/issues/6).

This does **not** pick a winner. It produces real syntax to react to, so that
[Decide how expressive a workflow definition is](https://github.com/uv404/t3code/issues/11)
is settled against something concrete.

Nothing here is wired into the server.

```sh
node experiments/workflow-definition-formats/dryRun.ts
```

## The workflow being expressed

Every sketch writes out the same workflow — the one the spike hardcodes at
`6fcca9e63`. Stating it as `Plan → Implement → Test → Review → (FAIL → Fix →
Test → Review)` undersells what a format has to carry, so here is the real
shape, read off `WorkflowRunner.ts`:

```
plan → implement → loop attempt = 1..3 {
                     test    → exit 0 or nonzero: continue (both go to Review)
                             → spawn error / timeout: abort the run
                     review  → PASS       : run passed
                             → unreadable : run failed, distinctly
                             → FAIL       : last attempt? run failed. else ↓
                     fix     → back to test
                   }
```

Four things in there are what actually separate the formats, and all four are
easy to miss when sketching against the tidy version:

1. **Test is inside the loop**, so this is a bounded cycle, not a chain with a
   back-edge.
2. **Three-valued outcomes, twice.** Review is pass / fail / **unreadable**;
   Test is success / **command-failed** / infrastructure-failure. The third
   value is where the interesting bugs live — the spike found a task phrased
   with an escape hatch producing a _legitimate_ `PASS` on a failing suite.
3. **Infrastructure failure is an ambient abort, not an edge.** No sketch
   expressed it as a transition; all of them left it implicit.
4. **Prompts are per-node templates with conditional sections** — Review quotes
   the Fix report only from attempt 2 onward.

## The sketches

| Sketch                                                                                                      | Form                                             |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| [`a-declarative/workflow.transitions.yaml`](a-declarative/workflow.transitions.yaml)                        | A1 — data, explicit per-outcome transition table |
| [`a-declarative/workflow.structured.yaml`](a-declarative/workflow.structured.yaml)                          | A2 — data, nested `retry:` control flow          |
| [`b-typescript/workflow.builder.ts`](b-typescript/workflow.builder.ts)                                      | B1 — typed builder                               |
| [`b-typescript/workflow.function.ts`](b-typescript/workflow.function.ts)                                    | B2 — plain async function                        |
| [`c-t3-stored/workflow.record.json`](c-t3-stored/workflow.record.json) + [`NOTES.md`](c-t3-stored/NOTES.md) | C — authored in-app, persisted in T3 state       |

Awkward parts are marked `⚠ (n)` inline. They are the deliverable — the files
are worth reading over this summary.

## What the dry-run showed

`dryRun.ts` pushes A1, B1 and B2 through five scripted scenarios (happy path,
retry-then-pass, retry-limit, unreadable verdict, mid-run provider timeout) and
compares the executed node path.

**All three agree on all five.** Same nodes, same order, same attempt numbers,
same failure kinds. So the formats are not competing execution models — they
express the same workflow, and the choice between them is about authoring,
storage and inspection, not about what can run.

Two results came out of _building_ it that were not visible from sketching:

- **The interpreter had to invent two rules the document never states.** What
  `attempt` means (this one counts entries into a node; counting trips around
  the cycle is an equally valid reading that yields different prompts), and
  what `maxReviewAttempts` bounds (hardcoded to "the node with a verdict",
  which is meaningless the moment there are two cycles). Both are ⚠ (1) and
  ⚠ (7) in A1, demonstrated rather than asserted.
- **The template engine needed a comparison operator and whitespace rules
  within thirty lines.** Rendering Review at attempt 1 leaves a stray blank
  line where the stripped `{{#if}}` block was. Nothing in the YAML says
  whether that is correct.

The run's own closing note is worth repeating: agreement is about _control flow
only_. Prompt authoring is where the formats really diverge, and the dry-run
does not compare prompts.

## Where each strains, and what it makes easy

**A1 — transition table.** Easy: a real static graph, stable node ids
(`review#2`), every outcome explicitly routed, trivially checkpointable and
renderable. Strains: the loop exists only as a cycle, so its bound has nowhere
to live but a global setting three screens from the edge it constrains; the
`fail: fix` edge is a lie by omission, because on the last attempt it ends the
run instead; and prompts need a template mini-language.

**A2 — structured control flow.** Easy: the bound sits on the block it bounds,
and it reads top-to-bottom the way a human describes the workflow. Strains:
node identity degrades from an id to a path (`steps[2].retry.steps[1]`) that
renames itself when a step is inserted above it; the static graph is gone, so
every consumer needs the interpreter to answer "what will run"; and you get
only the shapes the schema anticipated — each of `if`, `while`, `parallel` is a
schema change plus an interpreter change plus an editor change.

**B1 — typed builder.** Easy: `latest.pln` is a compile error rather than an
empty string discovered three paid agent turns into a run; the conditional
prompt section is a ternary, which deletes the entire template language; the
back-edge is generated; the verdict reader is an ordinary testable function.
Strains: **its prompts are closures and do not serialize**, so it cannot be
stored, diffed or shown in a form editor; user code runs on the T3 server _in
the hot path_, since each prompt closure fires mid-run; non-TS authors and
in-app editors are locked out; and it has A2's expressiveness ceiling exactly,
because it still emits a static document.

**B2 — plain function.** Easy: everything about control flow, free and
unlimited. Infrastructure failure unwinds as an exception, which is why every
other format could leave it implicit. Strains: nothing is knowable before it
runs — not the node list, not a graph, not "3 of 7 done" — so a pre-run
progress view is unavailable _in principle_; two versions cannot be
meaningfully diffed; the retry bound is a literal in user code, so T3 cannot
enforce a ceiling by inspection; and it is arbitrary code execution with no
ceiling at all.

**C — T3-stored.** As a _format_, C is A — the record wraps the A1 document
unchanged. What storage changes is everything around it: versioning stops being
free (git gives the in-repo forms immutable history and run-pinning at zero
design cost), the definition can no longer be reviewed in the same PR as the
code it acts on, and scope has to become explicit. Details in
[`c-t3-stored/NOTES.md`](c-t3-stored/NOTES.md), including the hybrid worth
naming: repo file as source of truth, T3 indexing a parsed copy.

## Questions the sketches raised that were not obvious beforehand

1. **The format decision and the durability decision are one decision.** A
   static document checkpoints trivially — "at `review`, attempt 2" is a row. A
   function has no such position; surviving a restart means deterministic
   replay with every step memoized and all other side effects banned, or
   capturing continuations. Since the destination requires runs that survive
   restarts, this constrains
   [Decide the durability and persistence model](https://github.com/uv404/t3code/issues/13)
   and is constrained by it. They cannot be answered independently.

2. **The format decision also sets the ceiling on watching a run.** A pre-run
   progress list is only possible for a statically enumerable definition. That
   #9 blocks both [#11](https://github.com/uv404/t3code/issues/11) and
   [Decide how a user watches a run](https://github.com/uv404/t3code/issues/14)
   turns out to be exactly right, for a sharper reason than "the format comes
   first".

3. **Prompt authoring is a primary driver of format choice, not a trailing
   detail.** It is the single biggest difference between the families: the data
   formats need a template language _with conditionals_, and TypeScript gets it
   for free. The map currently files "Prompt authoring per node" under **Not
   yet specified**; these sketches say it belongs at the front.

4. **The prompt is the part that resists serialization.** That is _why_ the
   declarative forms need a template language, and it is what makes B1 and C
   mutually exclusive. The graph serializes easily; the prompt does not.

5. **Bounded loops belong to cycles, and a transition table has no way to say
   so.** Fine with one cycle, ambiguous with two.

6. **The verdict reader is load-bearing, and it is a product question.** Every
   format had to answer "how do you turn an LLM's prose into a branch" and none
   answered it well. Both options are bad: built-in named readers mean users
   get only the verdicts T3 ships, and user-supplied patterns mean users can
   write a wrong one and find out mid-run. Given the spike's legitimate-PASS
   finding, this may deserve its own decision rather than being a field in
   whatever format wins.

7. **Should infrastructure failure be catchable?** Every sketch made it an
   ambient abort by omission rather than by decision. Whether a user can route
   a provider timeout is a real question, and it touches
   [Decide the failure taxonomy and retry policy](https://github.com/uv404/t3code/issues/15).

8. **The authoring surface applies its own pressure on expressiveness**, in the
   opposite direction from the runtime. A form or graph editor has to be able
   to emit the format, which pushes it toward flat and enum-heavy and designs
   out free-text expressions. That pressure is invisible if storage and
   expressiveness are decided separately.

9. **"TypeScript vs YAML" is the wrong axis.** B1 compiles to A1's document and
   runs on A1's interpreter. The real split is **static document vs arbitrary
   function** — and TypeScript sits on both sides of it. A format decision that
   starts from syntax will miss this.

## What this prototype does not settle

Node vocabulary beyond agent and command; triggers; how outputs pass between
nodes beyond the spike's "latest output per node, rendered as text"; and the
actual choice. Those are their own tickets.
