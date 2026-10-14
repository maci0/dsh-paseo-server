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
dsh plugin --profile web add @maci0/dsh-paseo-server@0.1.1
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

Works, verified against the shipped Paseo CLI and the Paseo client: pairing, the
relay transport with end-to-end encryption, workspace and agent listing, agent
creation (both `agent.create.request` and the legacy `create_agent_request`),
timeline reads, prompt send, interrupt, wait-for-finish, provider and model
catalogs, and the pairing card with its QR.

A full turn was driven end to end: `paseo run --provider <p>/<m>` created a DSH
session, the harness ran the model call, and the client read the reply back from
the timeline, both over a direct socket and through `relay.paseo.sh`.

Not mapped: terminals, workspace scripts, git and forge panels, schedules.

## Testing on the emulator

The plugin needs no Android build: it is reachable from an emulator at
`10.0.2.2:<port>`, which the emulator maps to the host loopback interface.

```bash
emulator -avd <avd> &
adb shell am start -a android.intent.action.VIEW -d "$(curl -s localhost:3080/paseo/pairing | jq -r .url)"
```

That opens the Paseo client with the pairing offer and shows the confirm
dialog with this daemon's server id, key fingerprint, and relay. What was
verified here:

- `GET /api/status` over HTTP from inside the emulator, through `10.0.2.2`.
- The pairing offer opened in the emulator's client, showing
  `srv_...`, the public-key fingerprint, and `relay.paseo.sh:443`, then
  connecting and listing this daemon's DSH workspaces and agents.

The Android app itself (`sh.paseo`, version 0.11.2) installs into the emulator,
but the build is ARM64-only and carries Google Play's PairIP integrity check.
On an x86_64 emulator its native libraries must be present in the app's
`lib/arm64` directory, and once it launches the license check refuses a
copy that was not installed through Play. Install it from Play on a real
device or on a Play-enabled emulator image instead.

## Testing with a headless desktop client

When the phone build will not cooperate, the desktop shell is the same client
without those restrictions. It runs under Xvfb in a container, and the DevTools
protocol drives it:

```bash
PASEO_TARBALL=~/Downloads/Paseo-0.11.2-x64.tar.gz docker/run-headless.sh
bun .scratch/cdp.ts open "$(curl -s localhost:3080/paseo/pairing | jq -r .url)"
```

See [docker/README.md](docker/README.md) for the whole flow. Verified: the
client showed this daemon's server id, key fingerprint, and relay in its
connect dialog, connected, and listed this daemon's DSH workspaces.

## Development

```bash
bun install
bun test
bun run typecheck
bun run build
```
