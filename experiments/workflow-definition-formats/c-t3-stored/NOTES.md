# Sketch C — T3-stored: what actually changes

PROTOTYPE — throwaway.

The most useful thing this sketch produced is a negative result: **as a
_format_, C is A.** `workflow.record.json` wraps the A1 document unchanged. If
you were expecting the storage decision to also settle the syntax decision, it
does not.

What storage changes is everything _around_ the document — and each item below
is a decision someone has to make that the in-repo forms never raise.

## 1. Versioning stops being free

An in-repo definition gets history, blame, review, revert and "which version
was this run started with" from git, at zero design cost. A stored definition
needs all of that invented: immutable versions, a version pointer on every run,
and a rule for what happens when someone edits a workflow while a run is
in flight.

Worth noting: the spike's own issue (#1) lists _"workflow definitions or
immutable workflow versions"_ under **Out of Scope**. Choosing T3-stored pulls
that straight back into scope. Choosing in-repo mostly keeps it out.

## 2. It cannot be reviewed alongside the code it acts on

The workflow runs `pnpm test`. Someone renames that script. In-repo, the
definition and the rename are in the same pull request and the same review.
T3-stored, they are in different systems and the workflow breaks silently on
its next run.

The inverse case is real too: a workflow whose _trigger_ is a GitHub issue may
need to exist before any worktree is checked out — see the triggers ticket.
Some workflows genuinely do not belong to a repo.

## 3. The editor becomes the schema's real consumer

This is the finding that was not obvious going in.

If the definition is authored in-app, a form or graph editor has to be able to
emit it — and that pushes the schema toward flat, enum-heavy, closed shapes.
Free-text expressions, user-supplied regexes and template languages with
conditionals are all _hard to build a good editor for_, so they get designed
out.

So the authoring surface applies its own pressure on expressiveness, in the
opposite direction from the runtime's. That pressure is invisible if you decide
storage and expressiveness as separate questions.

It also means C and B1 are mutually exclusive in a way that is easy to miss: a
typed builder's prompts are closures (see ⚠ 11 in `workflow.builder.ts`), and
closures cannot be stored, rendered in a form, or diffed.

## 4. Scope has to be explicit

A file's scope is where it lives. A stored definition needs to say whether it
belongs to a project, a user, or the whole T3 install — and that interacts with
triggers and with which worktree a run gets.

## 5. Portability

A repo definition travels with a clone and works for a teammate who has never
opened T3. A stored one does not.

## The hybrid worth naming

**Repo file as the source of truth; T3 indexes a parsed copy.**

Git keeps authoring, review, versioning and run-pinning. T3 still gets the
queryable list it needs to show workflows in a UI and to match an incoming
trigger against them without cloning anything first.

Cost: a sync/staleness story, and the in-app editor either disappears or has to
write back to the repo. It is not free — but it is the only option here that
does not force a choice between "reviewable next to the code" and "visible to
T3 before a checkout exists".
