---
title: Development Setup
---

# Running Locally

This guide will help you run the project locally for development or testing purposes.

EUDIPLO is organized as a **monorepo workspace** containing:

- **Backend** (`apps/backend/`) - NestJS API server
- **Client** (`apps/client/`) - Angular web interface
- **Webhook** (`apps/webhook/`) - Cloudflare Worker for testing

## Prerequisites

Before you start, make sure you have the following tools installed:

- [Node.js](https://nodejs.org/) (version 22+ recommended)
- [pnpm](https://pnpm.io/) (package manager for monorepo workspaces)
- [Git](https://git-scm.com/)
- [ngrok](https://ngrok.com/) (optional, for exposing a public URL)
- [Docker](https://www.docker.com/) (optional, for supporting services or containerized deployment)

:::tip[No Node.js installation required]
If you can't or prefer not to install Node.js locally, you can use **Dev Containers** to develop entirely inside a Docker container. See [Dev Container Setup](#dev-container-setup) below.
:::

## 1. Clone the Repository

```bash
git clone https://github.com/openwallet-foundation/eudiplo
cd eudiplo
```

## 2. Install Dependencies

Install all workspace dependencies:

```bash
corepack enable
pnpm install
```

This will install dependencies for all applications in the workspace.

## 3. Set Up Environment Variables

Create a `.env` file in the root of the project:

```bash
cp .env.example .env
```

To allow your wallet to interact with your service, a **public HTTPS URL** is required. You can use **ngrok** to expose your local server:

:::note
TODO: check if it also runs in a local network when using wallets.
:::

```bash
ngrok http 3000
```

ngrok will display a public HTTPS URL like:

```text
https://f8e3-84-123-45-67.ngrok.io
```

Use this value in your `.env`:

```env
PUBLIC_URL=https://f8e3-84-123-45-67.ngrok.io
```

:::tip[Environment Variable Validation]
The project validates your environment variables on startup using Joi. If `PUBLIC_URL` is missing or invalid, the app may fail to register with external services.
:::

:::note[Outbound calls to local services]
Webhooks, attribute providers and metadata imports reject HTTP and private or loopback targets by default, also in development. To call services running on your machine, enable `OUTBOUND_URL_ALLOW_HTTP=true` and `OUTBOUND_URL_ALLOW_PRIVATE_NETWORK=true` in your `.env`. The dev container sets both.
:::

:::caution[Skip flags]
`SKIP_*` variables (for example `SKIP_OVERASKING_CHECK`) turn off checks of the normal flow for development and interoperability testing. The backend lists active ones as warnings on startup. See [Skip Flags](../deployment/environment-variables.md#skip-flags).
:::

Check out the [Key Management System (KMS)](../administration/kms.md) or [Database](../administration/database.md) sections for more information on how to configure key storage and database options beyond the default settings.

## 4. Start the Applications

### Option A: Start All Services with Docker Compose

```bash
# Start both backend and client
docker compose up -d

# View logs
docker compose logs -f
```

### Option B: Start Individual Applications

**Start the Backend (NestJS API):**

```bash
pnpm --filter @eudiplo/backend run dev
```

**Start the Client (Angular UI) - in another terminal:**

```bash
pnpm --filter @eudiplo/client run dev
```

**Start the Webhook (for testing) - in another terminal:**

```bash
pnpm --filter test-rp run dev
```

### Option C: Start All Applications Locally

```bash
# Start all applications in development mode
pnpm run dev
```

This will:

- Compile and watch your TypeScript code
- Reload on changes
- Use your `.env` configuration for keys, database, and registrar access

Make sure any external services (like PostgreSQL or Vault) are available, either locally or through Docker.

## 5. Access the Services

Once running, the applications are accessible at:

**Backend API:**

```
http://localhost:3000
```

**Client Web Interface:**

```
http://localhost:4200
```

**Or via the public URL configured with ngrok:**

```
https://f8e3-84-123-45-67.ngrok.io
```

---

## Dev Container Setup

If you can't install Node.js locally (e.g., restricted environment) or prefer a consistent development environment, you can use **VS Code Dev Containers** to develop entirely inside a Docker container.

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) installed and running
- [Visual Studio Code](https://code.visualstudio.com/) with the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)

### Quick Start with Dev Containers

1. **Clone and open in VS Code:**

    ```bash
    git clone https://github.com/openwallet-foundation/eudiplo.git
    cd eudiplo
    code .
    ```

2. **Reopen in Container:**
    - Press <kbd>F1</kbd> and select **"Dev Containers: Reopen in Container"**
    - Or click the green button in the bottom-left corner → "Reopen in Container"

3. **Wait for setup** - The container builds and dependencies install automatically (first run takes a few minutes)

4. **Start development:**

    ```bash
    pnpm dev          # Start both backend and client
    # Or run separately:
    pnpm dev:backend  # Start backend only (port 3000)
    pnpm dev:client   # Start client only (port 4200)
    ```

### GitHub Codespaces

You can also use [GitHub Codespaces](https://github.com/features/codespaces) for cloud-based development:

1. Go to the [repository on GitHub](https://github.com/openwallet-foundation/eudiplo)
2. Click **Code** → **Codespaces** → **Create codespace on main**

The codespace automatically uses the devcontainer configuration.

### What's Included

The development container includes:

| Tool     | Version | Purpose              |
| -------- | ------- | -------------------- |
| Node.js  | 24      | JavaScript runtime   |
| pnpm     | latest  | Package manager      |
| Python 3 | system  | Documentation tools  |
| Git      | system  | Version control      |
| Zsh      | system  | Shell with Oh My Zsh |

Pre-configured VS Code extensions:

- ESLint & Biome (linting/formatting)
- Angular Language Service
- Docker extension
- GitLens
- REST Client

### Port Forwarding

Ports are automatically forwarded:

| Port | Service     |
| ---- | ----------- |
| 3000 | Backend API |
| 4200 | Client UI   |

---

## 6. Troubleshooting

- Double-check `.env` values for typos or missing entries. Changes in the `.env` file require a restart of the application.
- Ensure required external services (e.g. Vault, PostgreSQL) are running.
- Clear NestJS cache with `rm -rf dist node_modules && pnpm install`.
- If ngrok fails, make sure port 3000 isn't blocked or already in use.
