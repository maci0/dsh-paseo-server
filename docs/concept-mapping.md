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

## Forge surface

The harness ships no forge client, so this plugin talks to GitHub's REST API
itself, with a token from `GH_TOKEN` or `GITHUB_TOKEN`. Without a token, or for
a remote that is not GitHub, the panel stays hidden and the daemon says why.

Reading covers the pull request for the current branch, its discussion, and one
check run's details. Writing covers opening a pull request, merging it with the
strategy the client asked for, and turning auto-merge on or off through
GitHub's GraphQL mutation, because auto-merge has no REST endpoint.

## Project and file surfaces

A Paseo project is a directory the client groups workspaces under. Adding one
creates the workspace record for that directory, removing one removes its
workspace records, and the picker that chooses the directory lists host paths
names-only. `paseo.json` is readable and writable through the project config
requests, with the revision check the client expects, so workspace scripts can
be edited from the phone.

The file explorer lists a directory or reads one file inside an advertised
workspace, refusing any path that resolves outside it. Images come back base64
with their media type, text as UTF-8, and anything with a NUL byte as binary
with no content. The daemon reports no available editors: it runs headless, and
offering an editor that cannot open would be a lie.

Workspace titles are fixed at creation here, pins apply to the Sessions a
workspace holds because DSH pins Sessions rather than workspaces, and the
unread mark is refused because nothing keeps one.

## Pull requests

`checkout_pr_status_request` resolves the workspace's `origin` remote, asks
GitHub for the pull request whose head is the current branch, and reports the
number, URL, title, state, refs, draft and merged flags, and mergeability.
Checks and review decisions are reported empty rather than guessed, because
reading them needs a second API surface.

Paseo schedules a prompt against an agent on an interval or a cron expression;
DSH stores the same thing per Session. The mapping is direct: the Paseo target
agent is the owning Session, an interval becomes `every_seconds`, and a cron
expression becomes the DSH cron rule with its zone.

The conversion is lossy in one direction by design. DSH also has one-shot
reminders, which Paseo cannot render, so they stay out of the listing instead
of appearing as a recurrence that would fire again. A cadence faster than the
DSH floor of one minute is refused with that reason.

DSH records no creation instant and no paused state. A listed reminder reports
when this daemon first saw it, and pause and resume answer with the reason they
cannot work here rather than pretending: delete the reminder instead. Run-once
delivers the prompt through the ordinary prompt path, so it resumes a persisted
Session the same way a message does.

## Workspace scripts and deletion

Paseo declares a workspace's scripts in `paseo.json` at the workspace root, so
this daemon reads the same file rather than inventing a second format. A
declared script runs as a DSH background job: start, stop, output, and exit
state come from the job registry, and the plugin claims a job controller at
mount because the registry only serves a composition that does.

The registry's output surface is the job ring, not a port, so a script reports
its declared port but no proxy URL, and health stays null because nothing here
probes it.

`delete_agent_request` answers with `agent_deleted` and archives the session.
DSH has no session delete, and the visible outcome is the same, so a delete
from the phone is reversible on the host instead of destroying history.

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

## Protocol provenance

The wire shapes follow Paseo 0.11.2. The plugin reimplements the subset it
uses instead of importing `@getpaseo/protocol` or `@getpaseo/relay`: both are
published on npm without a license field and without a license file, so no
grant to redistribute them exists. Only the message shapes, which are protocol
facts, are mirrored.
