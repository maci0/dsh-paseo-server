# Paseo desktop client, headless.
#
# The Paseo client is the same code in three shells: the mobile app, the
# browser page at app.paseo.sh, and this Electron desktop build. The mobile
# build is ARM64-only and carries Play's integrity check, so a headless
# desktop shell is the reliable way to drive a real client against a daemon
# that lives on this machine.
#
# The application itself is not baked into the image: it is bind-mounted from
# the official release tarball at run time, so the image stays small and the
# client version is whatever the caller mounts.
FROM debian:bookworm-slim

# Runtime libraries Electron links against, plus a virtual display.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libexpat1 \
      libgbm1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      xauth \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

# Electron refuses to run as root without --no-sandbox, and the caller passes
# it. The display comes from Xvfb started by the entrypoint.
ENV DISPLAY=:99
ENV ELECTRON_DISABLE_SECURITY_WARNINGS=1

COPY entrypoint.sh /usr/local/bin/paseo-entrypoint
RUN chmod 0755 /usr/local/bin/paseo-entrypoint

WORKDIR /opt/Paseo
ENTRYPOINT ["/usr/local/bin/paseo-entrypoint"]
