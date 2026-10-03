# Contributing to EUDIPLO

Thanks for your interest in contributing to **EUDIPLO** – your help is highly appreciated! 🎉

This guide will walk you through the steps to report issues, suggest features, and contribute code or documentation.

---

## Reporting Issues

If you find a bug, glitch, or unclear behavior:

1. **Search** existing [issues](https://github.com/openwallet-foundation/eudiplo/issues) to avoid duplicates.
2. If not found, **open a new issue** and include:
   - A short description
   - Steps to reproduce
   - Your environment (OS, Docker version, etc.)
   - Logs or screenshots if possible

---

## Suggesting Enhancements

Have an idea to improve EUDIPLO?

- Check if a [feature request](https://github.com/openwallet-foundation/eudiplo/issues) already exists
- Open a new issue with a `feature request` label and describe:
  - The problem you want to solve
  - The proposed solution
  - Alternatives considered (if any)

---

## Finding Issues to Work On

Looking for a good first contribution? Here are some places to start:

### Good First Issues

Check our [GitHub issues labeled `good first issue`](https://github.com/openwallet-foundation/eudiplo/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) for beginner-friendly tasks.

### SonarCloud Code Quality Issues

Our [SonarCloud dashboard](https://sonarcloud.io/project/overview?id=openwallet-foundation_eudiplo) shows code quality issues that make excellent first contributions:

- **Code Smells** – Small improvements to code readability and maintainability
- **Bugs** – Potential issues detected by static analysis
- **Security Hotspots** – Areas that need security review

These issues are self-contained, have clear guidance, and help you learn the codebase while improving code quality.

---

## Getting Started

### Option A: Local Development

1. **Fork the repo** and clone it locally:

   ```bash
   git clone https://github.com/your-username/eudiplo.git
   cd eudiplo
   ```

2. **Install dependencies** for the entire workspace:

   ```bash
   corepack enable
   pnpm install
   ```

3. **Set up your environment** for development:

   ```bash
   cp .env.example .env
   
   # Then set MASTER_SECRET, AUTH_CLIENT_ID and AUTH_CLIENT_SECRET
   ```

4. **Start the application(s)** you want to work on:

   ```bash
   # Option I:
   # Start just the backend
   pnpm run dev:backend
   
   # Start the generation of the SDK & API (requires a started backend)
   pnpm run gen:all

   # Start just the client (requires a generated SDK & API)
   pnpm run dev:client

   # Option II:
   # Or start all with Docker Compose
   docker compose up -d
   ```

### Option B: Dev Container (No Node.js Installation Required)

If you can't or don't want to install Node.js locally, use VS Code Dev Containers:

1. **Prerequisites**: Install [Docker](https://docs.docker.com/get-docker/) and [VS Code](https://code.visualstudio.com/) with the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)

2. **Clone and open in VS Code**:

   ```bash
   git clone https://github.com/your-username/eudiplo.git
   cd eudiplo
   code .
   ```

3. **Reopen in Container**: Press `F1` → "Dev Containers: Reopen in Container"

4. **Start development**: Dependencies install automatically, then run `pnpm dev`

See [.devcontainer/README.md](.devcontainer/README.md) for more details.

---

## Backend Architecture

See the [Backend Development guide](apps/docs/docs/contributing/backend-architecture.md#backend-development), the [target architecture](apps/docs/docs/contributing/backend-architecture.md) (where code goes, reference implementations) and the [refactoring plan](apps/backend/docs/refactoring-plan.md) (status, open findings, and how to continue the migration). Pick one bounded slice before implementation. Run the backend E2E suite locally with `pnpm --filter @eudiplo/backend test:e2e:local` ([E2E testing](apps/docs/docs/contributing/testing.md#e2e-testing)).

## Code Quality

This project uses [Biome](https://biomejs.dev/) for code formatting and linting:

```bash
# Format your code
pnpm run format

# Check for linting issues
pnpm run lint

# Fix linting issues automatically
pnpm run lint:fix
```

See [Code Quality Standards](apps/docs/docs/contributing/code-quality.md) for detailed guidelines.

---

## Pull Request Checklist

Before submitting:

- [ ] Code is tested and builds without errors
- [ ] Code formatting passes (`pnpm run format:check`)
- [ ] Linting passes (`pnpm run lint`)
- [ ] You've added/updated documentation as needed
- [ ] PR is focused on a single topic

Please **create your PR against the `main` branch**.

---

## Documentation Contributions

Documentation is a Docusaurus site in `apps/docs/`. To work with documentation:

```bash
# Build documentation
pnpm run build:docs

# Serve documentation with live reload
pnpm run dev:docs
```

The documentation includes:

- Cookbooks (end-to-end recipes) in `apps/docs/docs/cookbooks/`
- Guides in `apps/docs/docs/issuance/`, `apps/docs/docs/presentation/`, `apps/docs/docs/trust/` and `apps/docs/docs/operate/`
- Reference pages in `apps/docs/docs/reference/` (partly generated from code)
- Concepts in `apps/docs/docs/concepts/`
- Contributor guides in `apps/docs/docs/contributing/`
- Upgrade guides in `apps/docs/docs/upgrade/`

---

## Community & Conduct

We follow a [Code of Conduct](CODE_OF_CONDUCT.md) to foster an inclusive and respectful environment. Please be kind and constructive.

---

## Need Help?

- Open a discussion or issue on [GitHub](https://github.com/openwallet-foundation/eudiplo/issues)
- Contact the maintainers for guidance

Thanks for helping improve EUDIPLO!
