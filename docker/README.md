# Headless Paseo client

Drive a real Paseo client against a daemon on this machine, with no display and
no phone.

## Why this exists

The Paseo client is one codebase in three shells. The Android build is
ARM64-only and carries Google Play's PairIP integrity check, so a copy that was
not installed through Play refuses to start. The desktop shell has neither
restriction, so it is the reliable client for testing a daemon here.

## Run

```bash
PASEO_TARBALL=~/Downloads/Paseo-0.11.2-x64.tar.gz ./run-headless.sh
```

Get the tarball from the official release page:
<https://github.com/getpaseo/paseo/releases>. The desktop application is
Apache-2.0; the container mounts it read-only rather than baking it into the
image.

The script:

1. extracts the release into `.scratch/paseo-app` when it is not there yet;
2. builds `docker/Dockerfile`, a Debian image with Xvfb and Electron's runtime
   libraries;
3. gives the client's own bundled daemon a free port, because the client starts
   one before it will render;
4. mounts the host's speech models read-only so nothing download several hundred
   megabytes;
5. runs the client under `--network host` and `Xvfb :99`, with the DevTools
   protocol on `CDP_PORT` (default 9222).

## Drive it

The renderer is a normal web contents, so the DevTools protocol is enough to
inspect and operate it.

```bash
# What is on screen?
curl -s localhost:9222/json/list | grep -E '"(url|title)"'

# Screenshot the window.
bun .scratch/cdp.ts shot shot.png

# Open a pairing link and confirm it.
URL=$(curl -s localhost:3080/paseo/pairing | jq -r .url)
bun .scratch/cdp.ts open "$URL"
bun .scratch/cdp.ts eval "(() => { [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Connect').click(); return 'clicked' })()"
```

`--remote-debugging-port` is passed straight to the client. Paseo wraps Electron
with a Commander CLI that rejects Chromium switches such as `--disable-gpu`, so
the sandbox is disabled through `ELECTRON_DISABLE_SANDBOX` in the entrypoint
instead.

## What this verified

Against a DeepSeek Harness daemon on `127.0.0.1:44889`:

- the client opened the pairing offer and showed this daemon's server id, public
  key fingerprint, and relay endpoint in the confirmation dialog;
- after Connect, the client listed the daemon's workspaces.
