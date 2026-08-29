# Context Map

One entry per context. A context is a workspace package with its own vocabulary; its `CONTEXT.md` is the glossary for that vocabulary, and its `docs/adr/` holds decisions that bind only it.

`CONTEXT.md` files are written lazily by `/domain-modeling` — when a term actually needs pinning down, not upfront. An entry with no file yet is normal.

Consumer rules for agents: `docs/agents/domain.md`.

## Contexts

| Context                            | Glossary                                      | What it owns                                                               |
| ---------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| `apps/server`                      | `apps/server/CONTEXT.md`                      | WebSocket, orchestration, provider adapters, checkpointing. Effect-heavy.  |
| `apps/web`                         | `apps/web/CONTEXT.md`                         | React/Vite UI.                                                             |
| `apps/desktop`                     | `apps/desktop/CONTEXT.md`                     | Desktop wrapper around the web app.                                        |
| `apps/mobile`                      | `apps/mobile/CONTEXT.md`                      | React Native client.                                                       |
| `apps/marketing`                   | `apps/marketing/CONTEXT.md`                   | The marketing site.                                                        |
| `packages/contracts`               | `packages/contracts/CONTEXT.md`               | Effect/Schema contracts and small derived helpers. No heavy runtime logic. |
| `packages/shared`                  | `packages/shared/CONTEXT.md`                  | Shared runtime utils. Subpath exports, no barrel.                          |
| `packages/client-runtime`          | `packages/client-runtime/CONTEXT.md`          | Client code shared by web and mobile.                                      |
| `packages/effect-acp`              | `packages/effect-acp/CONTEXT.md`              | ACP protocol bindings.                                                     |
| `packages/effect-codex-app-server` | `packages/effect-codex-app-server/CONTEXT.md` | Codex app-server protocol bindings.                                        |
| `packages/ssh`                     | `packages/ssh/CONTEXT.md`                     | SSH transport.                                                             |
| `packages/tailscale`               | `packages/tailscale/CONTEXT.md`               | Tailscale networking.                                                      |

System-wide decisions live in `docs/adr/`. The existing hand-maintained glossary is `docs/internals/glossary.md`.
