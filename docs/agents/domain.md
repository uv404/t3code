# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This is a **multi-context** repo: a root `CONTEXT-MAP.md` points at one `CONTEXT.md` per context, where a context is a workspace package under `apps/` or `packages/`.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — it points at one `CONTEXT.md` per context. Read each one relevant to the topic, not all of them.
- **`<context>/CONTEXT.md`** — the glossary for the package you're about to work in.
- **`docs/adr/`** at the root — system-wide decisions. Read the ADRs that touch the area you're about to work in.
- **`<context>/docs/adr/`** — decisions scoped to a single package.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

`docs/internals/glossary.md` is the existing hand-maintained glossary and predates this layout. Read it too; where it and a `CONTEXT.md` disagree, the `CONTEXT.md` is the newer word for that context.

## File structure

```
/
├── CONTEXT-MAP.md                     ← the map: one entry per context
├── docs/adr/                          ← system-wide decisions
├── apps/
│   ├── server/
│   │   ├── CONTEXT.md
│   │   └── docs/adr/                  ← context-specific decisions
│   └── web/
│       ├── CONTEXT.md
│       └── docs/adr/
└── packages/
    └── contracts/
        ├── CONTEXT.md
        └── docs/adr/
```

## Which ADR directory

- A decision that binds more than one package (wire protocol, event shape, checkpoint strategy) → root `docs/adr/`.
- A decision internal to one package (how the web app stores local UI state) → `<context>/docs/adr/`.
- When in doubt, root. A misplaced ADR nobody reads is worse than a broadly-scoped one.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

The same word can mean different things in different contexts — that's the point of a context map, not a bug to fix. When a term crosses a boundary, say which context you mean.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
