# dsh-paseo-server

Run DeepSeek Harness as a Paseo daemon, so the Paseo mobile app drives DSH
agents over the Paseo relay or over your LAN.

## Why

Paseo speaks one protocol to its daemon: list workspaces, list agents, stream a
timeline, send a prompt, interrupt a turn. DSH already owns all of that state.
This plugin presents it in that protocol instead of moving the state, so the
phone and the terminal see the same sessions, and nothing is duplicated.

## Install

```bash
dsh plugin --profile web add @maci0/dsh-paseo-server
```

Then restart the profile. The plugin mounts on the harness's own listener:

- `ws://<host>:<port>/ws` is the Paseo daemon socket.
- `GET /paseo/pairing` reports the pairing offer.
- `GET /paseo/pairing.svg` renders the pairing QR.

## Pair a phone

Open the Paseo card on the Plugins page. It shows a QR code, the pairing link,
and the CLI target. Scan the QR in the Paseo app, or paste the link.

To check the daemon from a terminal first:

```bash
paseo --host 127.0.0.1:3080 status
paseo --host 'https://app.paseo.sh/#offer=...' ls
```

The second form goes through the public relay with end-to-end encryption, which
is the path the phone uses.

## Configuration

Every field is editable from the Plugins page.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Mount the daemon at all. |
| `wsPath` | `/ws` | Path the Paseo client connects to. |
| `relayEnabled` | `true` | Dial the Paseo relay for off-LAN access. |
| `relayEndpoint` | `relay.paseo.sh:443` | Relay host and port. |
| `relayUseTls` | `true` | Use TLS for the relay connection. |
| `appBaseUrl` | `https://app.paseo.sh` | Origin the pairing link points at. |
| `passwordEnv` | `PASEO_PASSWORD` | Environment variable naming the daemon password; unset means no password. |
| `dataDir` | `$DSH_HOME/paseo-server` | Server id and key pair. |
| `defaultProvider` | `deepseek` | Provider reported when a session has no recorded header. |
| `defaultModel` | `deepseek-flash` | Model reported in the same case. |

## What maps to what

See [docs/concept-mapping.md](docs/concept-mapping.md). In short: a DSH session
is a Paseo agent, a DSH workspace record is a Paseo workspace, the repository
root behind a workspace directory is the Paseo project, and a DSH session event
is a timeline row.

## Security

- Relay traffic is end-to-end encrypted with XSalsa20-Poly1305. The relay routes
  bytes and cannot read them.
- Whoever knows the server id can claim the daemon's control socket on the
  relay and deny service. Set `passwordEnv` to require a password on `hello`
  for defence in depth.
- The identity files are written owner-only (`0600`).

## Status

Works: pairing, relay transport with end-to-end encryption, workspace and agent
listing, timeline reads, prompt send, interrupt, wait-for-finish, the pairing
card with its QR.

Partial: agent creation from the phone. Not mapped: terminals, workspace
scripts, git and forge panels, schedules.

## Development

```bash
bun install
bun test
bun run typecheck
bun run build
```
