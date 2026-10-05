# Development Container Setup

This project supports development inside a Docker container using **VS Code Dev Containers**. This allows developers to work on the project without installing Node.js or other dependencies on their local machine.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) installed and running
- [Visual Studio Code](https://code.visualstudio.com/) with the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)

## Getting Started

### Option 1: VS Code Dev Containers (Recommended)

1. **Open in VS Code**

   ```bash
   git clone https://github.com/EUDIPLO/eudiplo.git
   cd eudiplo
   code .
   ```

2. **Reopen in Container**
   - Press `F1` and select **"Dev Containers: Reopen in Container"**
   - Or click the green button in the bottom-left corner and select "Reopen in Container"

3. **Wait for Setup**
   - The container will build and dependencies will be installed automatically
   - This may take a few minutes on first run

4. **Start Development**

   ```bash
   pnpm dev          # Start both backend and client
   # Or run separately:
   pnpm dev:backend  # Start backend only (port 3000)
   pnpm dev:client   # Start client only (port 4200)
   ```

### Option 2: GitHub Codespaces

You can also develop using GitHub Codespaces:

1. Go to the [repository on GitHub](https://github.com/EUDIPLO/eudiplo)
2. Click the green **"Code"** button
3. Select **"Codespaces"** tab
4. Click **"Create codespace on main"**

The codespace will automatically use the devcontainer configuration.

### Option 3: Manual Docker Development

If you prefer not to use VS Code Dev Containers:

```bash
# Build and start the development container
docker compose -f .devcontainer/docker-compose.yml up -d

# Execute commands inside the container
docker compose -f .devcontainer/docker-compose.yml exec devcontainer bash

# Inside the container:
pnpm install
pnpm dev
```

## What's Included

The development container includes:

- **Node.js 24** with pnpm
- **Python 3** (for documentation)
- **Git** and GitHub CLI
- **Zsh** with Oh My Zsh
- Pre-configured VS Code extensions:
  - ESLint & Biome (linting/formatting)
  - Angular Language Service
  - Docker extension
  - GitLens
  - REST Client

## Port Forwarding

The following ports are automatically forwarded:

| Port | Service     | Description           |
| ---- | ----------- | --------------------- |
| 3000 | Backend API | NestJS API server     |
| 4200 | Client UI   | Angular web interface |

## Environment Variables

Default development environment variables are set in the docker-compose.yml:

- `PUBLIC_URL=http://localhost:3000`
- `DATABASE_TYPE=sqlite` (no external database needed)
- `MASTER_SECRET` and `AUTH_CLIENT_SECRET` are pre-set for development

For custom configuration, create a `.env` file in the project root.

## Troubleshooting

### Container won't start

- Ensure Docker is running
- Try rebuilding: `F1` → "Dev Containers: Rebuild Container"

### Ports already in use

- Stop any local services using ports 3000 or 4200
- Or modify the port mappings in `.devcontainer/docker-compose.yml`

### Slow performance on macOS/Windows

- The devcontainer uses volume caching for better performance
- Consider using Docker's "Use the WSL 2 based engine" on Windows

### pnpm install fails

- Delete the `node_modules` volume: `docker volume rm eudiplo_node_modules`
- Rebuild the container
