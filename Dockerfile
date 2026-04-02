# The cloudflare/sandbox base image ships the container agent that handles
# /ws/pty (terminal), /exec, /files, etc. on port 3000.
# The -python variant includes Python 3, pip, and Node.js out of the box.
FROM docker.io/cloudflare/sandbox:0.8.4-python

# Extra tools useful in the interactive terminal
RUN apt-get update && apt-get install -y --no-install-recommends \
    vim \
    nano \
    jq \
    htop \
    net-tools \
    iputils-ping \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

EXPOSE 8080
