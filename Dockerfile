# The cloudflare/sandbox base image ships the container agent that handles
# /ws/pty (terminal), /exec, /files, etc. on port 3000.
# Version 0.8.9 includes the @cloudflare/sandbox/opencode integration support.
FROM docker.io/cloudflare/sandbox:0.8.9

# OpenCode binary location
ENV PATH="/root/.opencode/bin:${PATH}"
# Trust the Cloudflare Zero Trust CA so the container can reach
# Access-protected services (e.g. the MCP server at ai-sandbox.cloudemo.org).
ENV NODE_EXTRA_CA_CERTS="/usr/local/share/ca-certificates/zero_trust_cert.crt"
# Stable location for OpenCode runtime data (sessions, MCP auth, etc.)
ENV XDG_DATA_HOME="/home/user/.opencode-data"

# Cloudflare Zero Trust root CA — required for HTTPS from container to Access-protected origins
COPY chat-config/zero_trust_cert.pem /usr/local/share/ca-certificates/zero_trust_cert.crt
RUN update-ca-certificates

# Extra tools useful in the interactive terminal
RUN apt-get update && apt-get install -y --no-install-recommends \
    vim \
    nano \
    jq \
    htop \
    net-tools \
    iputils-ping \
    && rm -rf /var/lib/apt/lists/*

# Install OpenCode (the binary that runs `opencode serve` inside the container)
RUN curl -fsSL https://opencode.ai/install -o /tmp/install-opencode.sh \
    && bash /tmp/install-opencode.sh \
    && rm /tmp/install-opencode.sh \
    && opencode --version

# Copy the default OpenCode config (provider/model/MCP are injected at runtime
# by createOpencode() in chat-session.ts, which merges on top of this file)
COPY chat-config/opencode.jsonc /home/user/workspace/opencode.jsonc

# Prepare OpenCode data directory and initialise a git repo (OpenCode uses git
# internally for session snapshots)
RUN mkdir -p /home/user/.opencode-data/opencode \
    && mkdir -p /home/user/workspace \
    && cd /home/user/workspace \
    && git init \
    && git config user.email "sandbox@cloudflare.com" \
    && git config user.name "Sandbox"

WORKDIR /home/user/workspace

# Port 4096: OpenCode HTTP server (proxied by Worker at /chat/oc/*)
# Port 8080: Sandbox container agent (/ws/pty, /exec, /files — kept for /dash terminal)
EXPOSE 4096
EXPOSE 8080
