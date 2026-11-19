FROM node:26-bookworm@sha256:b7087bc4d973034b30854b378ba107f9fab622b47514cb7e2592e41b8bab8d49

# Install additional tools
RUN apt-get update && apt-get install -y \
    git \
    zsh \
    curl \
    wget \
    jq \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@latest --activate

# Install Oh My Zsh for better terminal experience (optional)
USER node
RUN sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended || true

# Set pnpm store directory
ENV PNPM_HOME="/home/node/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /workspace

# Keep container running
CMD ["sleep", "infinity"]
