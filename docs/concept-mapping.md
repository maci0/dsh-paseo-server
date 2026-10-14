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
| Agent | one root DSH Session, live or persisted | `id` is the DSH session id, so a Paseo client controls exactly the conversation DSH owns. A Session nothing is attached to is still an agent: prompting it resumes it, and its transcript comes from the durable history page. Subagent sessions (a `parentSession` header) are not listed; see Deferred. |
| Provider | DSH LLM provider id | For a live Session, the provider its request header names. For a persisted one, the configured default, because nothing has been read that would name another. |
| Model | DSH model id | Same source as the provider. |
| Agent status | Agent runtime state, folded with turn activity | See the status table below. |
| Timeline entry | one DSH session event | See the timeline table below. |
| Agent capabilities | DSH host features | Streaming, session persistence, session listing, reasoning stream, and tool invocation map directly. Dynamic modes and MCP servers are reported false. |

## Status

| Paseo agent status | DSH condition |
| --- | --- |
| `initializing` | The Agent exists but its first turn has not started. |
| `running` | A turn is open on the session. |
| `idle` | No turn is open, whether the session is live or persisted. |
| `error` | The last turn ended with an error. |
| `closed` | The Agent was disposed outside the plugin. |

A persisted session reports `idle` rather than `closed`, because a prompt
resumes it. `closed` would tell a client the agent is gone.

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
| `fetch_agent_timeline_request` | Fold the session log into timeline rows; for a persisted session, fold the durable history page. |
| `send_agent_message_request` | A prompt with its text and image parts, resuming a persisted session first. |
| `cancel_agent_request` | `Agent.cancel({ kind: 'user' })`; a session with no turn is a no-op. |
| `archive_agent_request` | `workspaceRegistry.archiveSession(sessionId)`, which also hides the session from the active list. |
| `wait_for_finish_request` | Resolve when the Agent leaves `running`, or at the client's deadline. |
| agent creation | `ctx.agents.create(...)` with the requested workspace directory as `meta.cwd`. |
| terminal requests | Answered with an empty terminal list until the terminal bridge lands; see Still to build. |
| provider and model catalogs | Served from `ctx.llm`, so the client composer has a model to select. |

## Still to build

Workspace scripts, schedules and heartbeats, agent deletion, and the
forge half of the git surface (pull requests, checks, forge search) is not
bridged yet. Each has a DSH counterpart to map onto, so none is deferred on
principle; this table tracks what is left.

| Paseo feature | Target |
| --- | --- |
| Workspace scripts | The DSH job registry. |
| Schedules and heartbeats | The DSH schedule plugin's own store. |
| Agent delete | Session removal, once the persistence service exposes it. |
| Forge panels and pull requests | A forge client, which the harness does not ship. |

## Terminals

Paseo terminals are workspace-scoped; DSH terminals are owner-scoped, one PTY
per Session. The bridge closes that gap by owning each terminal with the most
recently active live agent whose working directory is the requested workspace,
so a shell opened from the phone runs where the workspace runs.

Listing, creation, input, resize, rename, and close map straight onto the
terminal controller. Output does not ride the JSON envelope: Paseo carries it as
`[opcode][slot][payload]` binary frames, so a subscription is given a slot, the
attachment's recovery screen arrives as an output frame carrying its ANSI, and
later output follows on the same slot. Input and resize travel the same way in
the other direction, and the JSON `terminal_input` message is accepted for
clients that send it instead.

## Git surface

`checkout_status_request` reads the repository directly: root, current branch,
dirty state, origin URL, upstream ref, and the ahead/behind counts against that
upstream.

`checkout.diff.get.request` returns the parsed diff: one entry per changed file
with its hunks and typed lines, so the client renders additions and deletions
without parsing anything itself. `subscribe_checkout_diff_request` opens a
bounded poll: the daemon re-reads the diff and sends `checkout_diff_update` only
when the parsed result changed. Git has no watch API, so a poll is the honest
mechanism; the subscription ends when the client unsubscribes or its socket
closes.

Only directories this daemon advertised are read, so neither request can be
used as a path probe into the operator's machine.

Writes are the three the client offers. `checkout_commit_request` stages
everything when the client asks for it, then commits with the client's message,
or one derived from the changed paths when it supplied none.
`checkout_push_request` pushes the current branch and sets its upstream on the
first push; a force push is never attempted. `checkout_pull_request` runs
`--ff-only`, so a pull that would need a merge reports `MERGE_CONFLICT` instead
of creating a merge commit nobody asked for. `checkout.refresh.request`
acknowledges, because git reports its state on every read and the client then
re-reads status and diff.

## Deferred

| Item | Note |
| --- | --- |
| Subagent projection | DSH child sessions carry `origin: 'subagent'`. Paseo has a provider-subagent surface, which is the natural target. |
| Delete | Paseo hard-deletes an agent. DSH archives a session instead, which is the same visible outcome and stays reversible. |

## Protocol provenance

The wire shapes follow Paseo 0.11.2. The plugin reimplements the subset it
uses instead of importing `@getpaseo/protocol` or `@getpaseo/relay`: both are
published on npm without a license field and without a license file, so no
grant to redistribute them exists. Only the message shapes, which are protocol
facts, are mirrored.
