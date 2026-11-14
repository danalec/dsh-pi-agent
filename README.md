# dsh-pi-loop

English | [中文](README.zh.md) | [Português (BR)](README.pt-BR.md) | [日本語](README.ja.md) | [Español](README.es.md)

Run the [Pi coding agent](https://github.com/earendil-works/pi) ([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)) as the agent loop inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ([`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)): a DSH `Agent` plugin that drives a headless `pi --mode rpc` child process, so DSH's frontend — session log, hooks, presets, web UI — works unchanged.

> **Looking for one of these?**
> - *"How do I use pi inside DeepSeek Harness / DSH?"* — you are in the right place.
> - *"Swap the DSH agent-loop for the pi coding agent loop?"* — this plugin replaces the factory with a `pi --mode rpc` child process.
> - *"Run pi with a web UI / browser frontend?"* — dsh-pi-loop + the official DSH web app gives pi the full web interface: session persistence, hooks, presets, model selection.
> - *"Use a minimal clean prompt inside DSH?"* — the pi engine keeps its ~300-token system prompt and four tools; DSH's prompt assembly never reaches the model. Zero prompt injection.
> - *"Claude Code / Codex subagents inside DSH?"* — DSH already supports those natively; this plugin adds pi as an engine option the same way.

```
DSH frontend (sessions, hooks, presets, SQLite persistence, web UI)
        │
dsh-pi-loop  (this plugin: AgentFactory + event translation + history handoff)
        │  spawn + JSONL over stdio
        │  commands: set_model / prompt / steer / abort
        ▼
pi --mode rpc --session <rebuilt-history>   (the Pi agent loop, untouched)
```

On every create/resume the plugin rebuilds a Pi session file from DSH's durable event log and launches the child with `--session`, so the child's context window already holds the full conversation — including turns that ran under DSH's own loop before the switch (see [Mid-session handoff](#mid-session-handoff)).

## Why

Pi is a minimal harness: a ~300-token system prompt, four tools (`read`/`bash`/`edit`/`write`), and zero mid-session injections. DSH ([DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)) is a plugin-based platform: durable sessions, policies, approval chains, and a full prompt-assembly registry.

This plugin gives you both at once: **DSH's engineering shell around Pi's clean engine.** When the plugin is active, the model sees exactly what it would see running `pi` directly in the same working directory — no extra prompt sections, no extra tools, no hidden reminders. DSH's own prompt assembly (`dsh-system-prompt`) and tool surface are bypassed entirely for sessions driven by this factory.

It also makes a clean A/B experiment: same frontend, same session format, switch the plugin on/off to compare DSH's native loop against the bare Pi loop.

## What changes vs. what doesn't

| Layer | Behavior |
| --- | --- |
| System prompt / tools / context | **Untouched** — identical to running `pi` in the same directory (context files like `AGENTS.md` are loaded by Pi itself) |
| Model routing | `set_model` per session; a delegated subagent's requested model wins over the factory default. A model without a provider borrows the default's provider — the provider slot never receives a model id. A route Pi refuses fails the turn loudly instead of silently running Pi's default model |
| Steering | DSH `send(..., 'next-turn' \| 'next-step')` maps to Pi's `steer` — inject instructions mid-run. The instruction is delivered to the running loop exactly once, and a batch Pi never injects is recovered and delivered as a step of its own instead of being dropped |
| Queue | the frontend's queue dock reads the `inbox` session projection, which the native loop owns; the Pi loop registers it itself, so the queued and steering items stay visible |
| Session persistence | DSH's session events remain the durable source of truth; a Pi session file is rebuilt from them on every create/resume so the child starts with full history |
| Approval / permissions | Pi's local-trust model applies — Pi tool calls do not pass through DSH's approval chain |
| Fallback | Disable this plugin's entry and re-enable `agent-loop`: DSH's own `dsh-agent-loop` becomes active again immediately. Only one factory may hold the agent slot at a time, so the two entries are mutually exclusive |

## Boundary mapping

The bridge translates Pi's internals onto DSH's turn/step model:

| DSH | Pi |
| --- | --- |
| one turn | one `prompt` command (one Pi run) |
| one step | one assistant message (one model call plus the tool executions it requested) |
| step boundary | Pi's `turn_end` event (the assistant turn finished) |
| next-step input | Pi's `steer` command (delivered right before the next LLM call) |

A turn closes when Pi reports `agent_settled` — not on `agent_end`, which only ends one low-level run while retries, compaction recovery and queued work may still follow.

## DSH agent hooks

The plugin implements the agent-subject events the frontend and the policy
chain rely on:

| Event | Behavior |
| --- | --- |
| `agent/status` | `idle` ⇄ `running`, mirrored on every transition |
| `agent/inbox/inserted` / `claimed` / `discarded` | the pending input is **claimed** when it enters a step (never recorded as a cancellation) |
| `agent/pre-step` | dispatched before each step; a `reject` blocks the turn (`turn/end` reason `blocked`) and Pi is never prompted |
| `agent/turn-stopping` | dispatched at the turn's stop boundary; steering injected there runs another step in the same turn |
| `agent/created` | the registry announces the agent with `source: 'startup'` for a fresh session, `'resume'` for a persisted one |
| `agent/assistant-stream` | the start/chunk/end frames of one assistant attempt, published live |
| `agent/error` | reported at the live boundary; the turn still closes with an error reason |

Two agent events are **not** emitted, because their semantics cannot be
honored across the process boundary: `agent/request` and `agent/request-error`
wrap the model call itself, which happens inside the Pi child. A listener
that needs to influence the model call has to use Pi's own extensions.

## Mid-session handoff

A session does not have to be born under Pi to be driven by it. If a session already ran turns under DSH's own loop (or under an earlier Pi child), resuming it through this plugin picks the conversation up where it left off: DSH's event log (`user/message`, `assistant/message`, `tool/call`, `tool/result`) is converted into a Pi session file and the new child loads it with `--session`, so the full history — earlier DSH-native turns included — lands in its context window.

- DSH remains the single source of truth; the Pi file is a rebuilt snapshot, regenerated on every create/resume (no drift, no duplication).
- DSH message blocks map natively: `text` → `text`, `reasoning` → `thinking`, `tool-call` → `toolCall` (arguments re-parsed), `tool/result` → `toolResult` (tool name recovered from the call log).
- The token usage travels with the assistant message: Pi's session reader needs it to estimate the context, and a resumed run without it cannot prepare its request.
- Image blocks are currently skipped (attachment refs need the live attachment service); text history carries the context.
- The rebuilt file keeps a stable session identity (derived from the DSH session id), so a handoff is a continuation, not a new session.
- Session files land under `~/.dsh/pi-sessions/<session-id>.jsonl` for audit.

```
DSH standard mode:   turn 1 ── turn 2 ── turn 3        (native loop)
                                        │
            resume via this plugin ─────┘  rebuild Pi session from DSH log
                                        ▼
pi mode:              [history loaded] ── turn 4 ── …  (Pi loop, full context)
```

## Subagents on Pi

Separate config from the main loop: the provider plugin is its own profile row, and the two engines are independently switchable — `pi` main loop with native subagents, native main loop with `pi` subagents, or both on `pi`.

```yaml
# Subagent delegation on the Pi engine (independent of the main loop row):
- insert:
    - id: subagent-pi
      name: 'dsh-pi-loop/subagent'
      config:
        providerName: pi
        piPath: 'pi'                  # defaults to PATH lookup
        model: 'provider/model'      # omit for pi's configured default
        timeoutMs: 600000

    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: pi                  # 'spawn'/'fork' for DSH-native children
        toolName: subagent
        backgroundMode: one-shot
        maxDepth: 'provider-managed'
```

Each delegation spawns a fresh `pi -p <task>` in the parent session's working directory: bare Pi system prompt, its own tools, its own `AGENTS.md` discovery. Nothing from the parent conversation, persona, or tool surface crosses the process boundary — `inheritsParentContext: false`, zero prompt collision.

## Compatibility

The plugin implements the DSH **0.2 agent API**, not the 0.1 one. It is developed
and tested against **DSH 0.2.2-rc.3**; the published peer range accepts every
`0.2.2-rc.x` of that line.

| DSH API | What the plugin does |
| --- | --- |
| `ctx.agents.setFactory` | registers the Pi factory synchronously, so a session created right after the plugin mounts finds it |
| `Agent.inbox` | the driver owns the pending input (`src/inbox.ts`); DSH 0.2 turned `Inbox` into a structural interface, the implementation belongs to the driver |
| `Agent.model` | the driver owns the durable model choice (`src/model.ts`) |
| `CreateAgentOptions.meta` | the session's own `cwd` and fork lineage (`parentSession`) travel as session metadata; the plugin passes them straight to the session boundary |
| `ctx.agents.enter(agent)` | the agent joins the registry with the agent alone — the parent link is session data, not a second agent argument |
| `agent/created` | the registry announces the agent with the session source (`startup` / `resume`) |
| `agent/assistant-stream` | the start/chunk/end frames of one assistant attempt |
| `assistant/message` | carries the provider stream inside the event (`stream`), not as separate chunk events |
| `tool/result` | the tool-result message carries the model-facing blocks directly |
| session persistence | `persistence.create()` / `persistence.open(id, 'write')` own the stored log; the events reach the backend through its `session/event` subscription |

### What changed in 0.2.2-rc.3

The 0.2.2 release candidates kept moving the factory contract, and rc.3 is the
shape the plugin is written against:

- `CreateAgentOptions.parentAgent` and `ResumeAgentOptions.parentAgent` are
  gone. The fork lineage is session data now:
  `CreateAgentOptions.meta.parentSession` (a `SessionId`); `resume` carries no
  metadata at all.
- `ctx.agents.enter(agent)` takes the agent alone — the parent argument is no
  longer part of the registry's contract.

DSH checks the plugin's peer range against the running runtime at install
time, so a version mismatch is reported before the plugin is ever mounted.

## Requirements

- Node.js ≥ 20
- [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (`npm i -g @earendil-works/pi-coding-agent`) on `PATH` (or pass `piPath`)
- [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) ≥ `0.2.2-rc.3` (`npm i -g @deepseek-ai/dsh`) with a profile exposing the `sessions`, `agents` and `sessionProjections` services (the standard frontend assembly)
- Peer deps: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-scope`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-session-projection`, `@deepseek-ai/dsh-subagent`

## Install

The package is not on the npm registry — the earlier `dsh-pi-agent` release was unpublished — so install it straight from the source tree. The profile's plugin manager forwards to pnpm, so a local checkout is installed like any other dependency:

```bash
# Link the working tree: the profile always runs your checkout (rebuild, then
# restart DSH). This is the development setup.
dsh plugin --profile desktop add link:/path/to/dsh-pi-loop

# Or install a copy of the directory (what `npm pack` would produce).
dsh plugin --profile desktop add file:/path/to/dsh-pi-loop
```

Both write the dependency into the profile's `package.json`; DSH then resolves the plugin's `@deepseek-ai/*` imports against its own installation, so exactly one DSH version is loaded in the process.

`link:` keeps the profile pointing at your checkout: edit, `npm run build`,
restart DSH — the change is live. `file:` installs a copy, so the profile runs
the code as it was when the install ran.

Every release also ships the packed tarball: [github.com/danalec/dsh-pi-loop/releases](https://github.com/danalec/dsh-pi-loop/releases).

Related: the [pi ecosystem](https://github.com/earendil-works/pi) also has [pi-gui](https://github.com/minghinmatthewlam/pi-gui), [pi-hosts](https://github.com/hunvreus/pi-hosts), [pi-zentui](https://www.npmjs.com/package/pi-zentui); DSH natively bridges [Claude Code](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-claude-code) and [Codex](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-codex) as subagent engines — dsh-pi-loop adds **pi** as an engine and loop option the same way.

## Usage

Mount in the profile patch layer (`cordis.patch.yml`). A new plugin is mounted with an `insert:` list — a bare `- id:` entry only overrides an entry that already exists:

```yaml
# DSH's own loop holds the agent-factory slot and only one factory may be
# registered, so the native entry steps aside while Pi is mounted.
- id: agent-loop
  disabled: true

# Use the Pi loop for all new sessions.
- insert:
    - id: pi-loop
      name: 'dsh-pi-loop'
      config:
        piPath: 'pi'                      # or an absolute path
        cwd: '/path/to/your/project'      # working directory for Pi sessions
        model: 'anthropic/claude-sonnet-4-5'  # provider/model route
        pinModel: false                   # keep Pi's route even if DSH asks for another
        debug: false

# Fall back to DSH's own loop: disable this entry and re-enable agent-loop.
# - id: pi-loop
#   disabled: true
```

### Config

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `piPath` | `string` | `'pi'` | Pi executable; resolved from `PATH` |
| `cwd` | `string` | `process.cwd()` | Working directory for Pi sessions (a session's own `cwd` wins) |
| `model` | `string` | — | Pi model route (`provider/model`) |
| `pinModel` | `boolean` | `false` | Always use `model`, ignoring the route DSH requests for a session. DSH's own providers are not Pi providers, so a session created with the frontend's model picker would otherwise hand Pi a route Pi refuses |
| `debug` | `boolean` | `false` | Append protocol diagnostics to `<tmpdir>/dsh-pi-loop.log` |

### Mounting rules

Two rules decide whether the plugin comes up:

1. **A new plugin is an `insert:` list.** A bare `- id: pi-loop` entry only
   overrides an entry that already exists — the loader answers
   `patch: entry "pi-loop" not found` and mounts nothing.
2. **Only one agent factory may hold the slot.** DSH's own `dsh-agent-loop`
   registers the factory first, so `agent-loop` has to be disabled while this
   plugin is mounted. Leaving both enabled fails with
   `an agent factory is already registered`.

## Session lifecycle

| Phase | What happens |
| --- | --- |
| create | the session is prepared, the persistence backend takes the write ownership of the stored log, the Pi session file is rebuilt from the (still empty) DSH log, and the child starts with `--no-session` |
| turn | DSH input is claimed from the inbox, the prompt goes to Pi, Pi's events become DSH session events, and the backend stores them through its `session/event` subscription |
| resume | the stored log is read back, an interrupted turn is closed durably, the session is seeded from the log, and the child starts with `--session <rebuilt file>` — the conversation it already had |
| dispose | the child is stopped, the scope unwinds, and the persistence handle is closed |

DSH's own checkpoint policy flushes the stored log at the request boundary, so
a turn is durable when the model call starts, not when it ends.

## Platform notes

- **Windows**: Pi ships as a command shim. The plugin resolves the shim
  (`.exe`/`.com`/`.cmd`/`.bat`) and launches a `.cmd`/`.bat` through `cmd.exe`
  with every argument quoted, so `pi.cmd` works out of the box. Point
  `piPath` at the shim if it is not on `PATH`.
- **POSIX**: the shim is an executable script and is spawned directly.
- The diagnostics file lives in the platform temp directory
  (`os.tmpdir()`), so it is writable on every platform.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `patch: entry "pi-loop" not found` | the entry is a bare `- id:` override instead of an `insert:` | wrap it in `- insert:` |
| `an agent factory is already registered` | DSH's `agent-loop` still holds the factory slot | disable `agent-loop` in the same patch layer |
| `no agent factory registered (load an agent-loop plugin)` | the plugin did not mount (wrong entry name, or the profile has no `agent-loop` and no `pi-loop`) | check the entry `name:` and the loader's diagnostics |
| Pi refuses the model route | DSH handed Pi a DSH provider | set `model:` to a Pi route and `pinModel: true` |
| The resumed turn produces no answer | the rebuilt Pi session file lacks the assistant usage | rebuild from a current checkout (`npm run build`); Pi needs the token count to prepare its request |
| Nothing happens on Windows | `pi` is a `.cmd` shim that the desktop app cannot find | point `piPath` at the absolute `pi.cmd` path |
| No diagnostics | `debug` is off | set `debug: true` and read `%TEMP%/dsh-pi-loop.log` |

## Debugging

Set `debug: true`: every RPC command, event, child-process exit, and factory
lifecycle step is appended to `<tmpdir>/dsh-pi-loop.log` (`%TEMP%` on
Windows, `/tmp` elsewhere). Pi's own stderr is forwarded into the same log.
With `debug` off no sink is installed at all — the protocol layer formats no
diagnostics and touches no disk.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # builds, then runs the node:test suite
npm run build       # refresh dist/ — what the profile actually loads
```

`package.json` pins the `@deepseek-ai/dsh-*` packages to `0.2.2-rc.3` through
an `overrides` block: the DSH packages pin each other's peers to an exact
version, so a mixed tree cannot be resolved — every one of them has to move
together.

`dist/` is what DSH loads, so a linked working tree needs `npm run build`
(and a DSH restart) to pick up a change.

The test runner needs Node ≥ 21 (its glob support); the library itself runs
on Node ≥ 20.11.

The suite covers the history rebuild (block mapping, stop reasons, session
identity), the Pi event translation (tool results, streamed tool-call ids,
settlement, cancellation, inbox claiming) and the RPC client against a fake
`pi` binary that speaks the real JSONL protocol.

`tools/dsh-e2e.mjs` drives the whole lifecycle against the real DSH packages:
it mounts the plugin on a bare context (sessions, agents, projections, the
JSONL persistence backend), creates a session, sends a prompt, disposes it,
resumes it from the stored log and sends a second prompt — printing the
session log and the rebuilt Pi session file at each step.

```bash
node tools/dsh-e2e.mjs
```

## License

Dual-licensed, at your option: **MIT** or **Apache-2.0**
(`MIT OR Apache-2.0`). Both are complete and free on their own terms.

Apache-2.0 is the better fit for corporate redistribution: besides the broad
copyright license, it grants a patent license (section 3) that terminates if
you initiate patent litigation against the copyright holder. MIT is the more
permissive of the two — shorter, no express patent grant, no NOTICE file.

Support, warranties and indemnification are not granted by either license.
They are a separate agreement with the copyright holder, not a third license
option.

Full texts: [`LICENSE`](LICENSE), [`LICENSE-MIT`](LICENSE-MIT),
[`LICENSE-APACHE`](LICENSE-APACHE).
