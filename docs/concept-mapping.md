# DSH and Paseo concept mapping

This document is the contract between the two models. The plugin presents
DeepSeek Harness (DSH) as a Paseo daemon, so every Paseo object a client asks
for is derived from a DSH object by the rules below. Anything not listed here is
not mapped and is reported as an empty collection rather than invented.

## Identity

| Paseo | DSH | Rule |
| --- | --- | --- |
| Daemon | this plugin instance | One DSH process runs one Paseo daemon. |
| `serverId` | generated, persisted | `srv_` plus 12 base64url characters, stored under the DSH plugin data directory. |
| Daemon key pair | generated, persisted | Curve25519 key pair used for relay end-to-end encryption. The public key is what a pairing QR carries. |
| Daemon version | plugin version | Reported in the `status` frame; the Paseo protocol version stays `1`. |

## Objects

| Paseo | DSH | Rule |
| --- | --- | --- |
| Project | git repository root of a workspace directory | `projectId` is a stable digest of the canonical repository root. Two workspaces in one repository share one project, which is what Paseo expects for a checkout and its worktrees. A directory that is not in a git work tree becomes its own project. |
| Workspace | one `ctx.workspaceRegistry` record | `workspaceDirectory` is the canonical directory path. `name` and `title` are the DSH workspace title. `workspaceKind` is `directory`, and `isPaseoOwnedWorktree` is false because DSH does not hand out worktrees. |
| Agent | one root DSH Agent, which is one Session | `id` is the DSH session id, so a Paseo client controls exactly the conversation DSH owns. Subagent sessions (a `parentSession` header) are not listed in the first release; see Deferred. |
| Provider | DSH LLM provider id | Paseo treats a provider as a free-form string. The plugin reports the provider the agent's request header names, falling back to the configured default provider. |
| Model | DSH model id | Same source as the provider. |
| Agent status | Agent runtime state, folded with turn activity | See the status table below. |
| Timeline entry | one DSH session event | See the timeline table below. |
| Agent capabilities | DSH host features | Streaming, session persistence, session listing, reasoning stream, and tool invocation map directly. Dynamic modes and MCP servers are reported false. |

## Status

| Paseo agent status | DSH condition |
| --- | --- |
| `initializing` | The Agent exists but its first turn has not started. |
| `running` | A turn is open on the session. |
| `idle` | The Agent is live and no turn is open. |
| `error` | The last turn ended with an error. |
| `closed` | The Agent was disposed outside the plugin. |

Paseo workspace status is derived from the statuses of the agents in that
workspace, most severe first: `needs_input`, `failed`, `running`, `attention`,
`done`.

## Timeline

| Paseo timeline item | DSH session event |
| --- | --- |
| `user_message` | `user/message` |
| `assistant_message` | `assistant/message` |
| `reasoning` | `assistant/attempt` reasoning content |
| `tool_call` | `tool/call`, completed by `tool/result` |
| `error` | a failed turn or a provider error event |
| `notification` | DSH notification events that carry no timeline identity |

Timeline rows carry the DSH session event sequence number as the Paseo `seq`,
and one epoch string per agent. A client that reconnects with a stale cursor is
answered with a full snapshot, which keeps the two sequence spaces aligned.

## Requests

| Paseo request | DSH action |
| --- | --- |
| `fetch_workspaces_request` | List `ctx.workspaceRegistry`. |
| `project.list.request` | Distinct project roots of those workspaces. |
| `fetch_agents_request` | List root Agents from `ctx.agents`, joined to their workspace. |
| `fetch_agent_request` | One Agent plus its placement. |
| `fetch_agent_timeline_request` | Fold the session log into timeline rows. |
| `send_agent_message_request` | `Agent.followup(createUserMessage(...))`. |
| `cancel_agent_request` | `Agent.cancel({ kind: 'user' })`. |
| `wait_for_finish_request` | Resolve when the Agent leaves `running`, or at the client's deadline. |
| agent creation | `ctx.agents.create(...)` with the requested workspace directory as `meta.cwd`. |
| terminal requests | Answered with an empty terminal list. See Not mapped. |
| provider and model catalogs | Served from `ctx.llm`, so the client composer has a model to select. |

## Not mapped

| Paseo feature | Why |
| --- | --- |
| Terminals | DSH exposes shell execution as a tool, not as a persistent PTY a plugin can attach a client to. Paseo's UI is usable without terminals, so terminal requests return an empty list. |
| Workspace scripts | DSH has no per-workspace script registry. |
| Git and forge panels | DSH keeps no forge session state of its own. Workspaces report `isGit`, a branch, and a remote, and the pull-request panel stays empty. |
| Schedules and heartbeats | DSH schedules belong to the DSH schedule plugin, which owns its own store and triggers. Mirroring them would give two sources of truth for one cadence. |

## Deferred

| Item | Note |
| --- | --- |
| Subagent projection | DSH child sessions carry `origin: 'subagent'`. Paseo has a provider-subagent surface, which is the natural target. |
| Archive and delete | Paseo archives an agent and deletes a workspace. DSH workspace deletion exists; agent archive does not. |
| Attachments and images | Paseo sends attachments with a prompt. The first release accepts text only and rejects a prompt that carries attachments. |

## Protocol provenance

The wire shapes follow Paseo 0.11.2. The plugin reimplements the subset it
uses instead of importing `@getpaseo/protocol` or `@getpaseo/relay`: both are
published on npm without a license field and without a license file, so no
grant to redistribute them exists. Only the message shapes, which are protocol
facts, are mirrored.
