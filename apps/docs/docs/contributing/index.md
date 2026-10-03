---
title: Contributing
---

# Contributing

EUDIPLO is organized as a **monorepo workspace** containing multiple applications and shared packages. This section guides you through the contributor journey from development setup to submitting changes.

## Contributor Journey

1. **[Development Setup](./development-setup.md)** — Install dependencies, configure environment variables, and run locally
2. **[Architecture Overview](../concepts/index.md)** — Understand the system architecture and design principles
3. **[Repository Structure](./development-setup.md#workspace-structure)** — Navigate the monorepo layout and workspace conventions
4. **[Backend Development](./backend-architecture.md#backend-development)** — Build and extend the NestJS API server
5. **[Client Development](./client.md)** — Work with the Angular management UI
6. **[CLI Development](./cli.md)** — Develop and test the command-line interface
7. **[Testing](./testing.md)** — Write and run unit tests
8. **[E2E Testing](./testing.md#e2e-testing)** — Integration and end-to-end test workflows
9. **[Conformance Testing](./testing.md#oidf-conformance-testing)** — OIDF conformance suite integration
10. **[Documentation](./documentation.md)** — Contributing to documentation
11. **[Releases](./releases.md)** — Versioning, release process, and backward compatibility
12. **[Code Quality](./code-quality.md)** — Formatting, linting, and style guidelines
13. **[Logging Configuration](../operate/logging.md)** — Debugging with logs and observability

## Quick Start

```bash
# Install all dependencies
pnpm install

# Start all applications
pnpm run dev

# Or start specific applications
pnpm --filter @eudiplo/backend run start:dev
pnpm --filter @eudiplo/client run dev
```

## Backend (NestJS)

The backend is built with [NestJS](https://nestjs.com/), a progressive Node.js framework for building efficient, scalable server-side applications using TypeScript.

### Source Code Structure

Each module typically contains its own:

- `controller.ts` — API endpoints
- `service.ts` — Business logic
- `dto/` — Data Transfer Objects
- `entities/` — TypeORM entities (if needed)

## Useful Development Scripts

```bash
# Development
pnpm --filter @eudiplo/backend run dev
pnpm --filter @eudiplo/backend run start:debug
pnpm --filter @eudiplo/backend run build

# Testing
pnpm run test             # Run unit tests
pnpm --filter @eudiplo/backend run test:watch
pnpm --filter @eudiplo/backend run test:e2e
pnpm --filter @eudiplo/backend exec vitest run --coverage --config ./vitest.config.ts
pnpm --filter @eudiplo/backend run test:debug

# Code Quality
pnpm -r run format        # Format all files with each package formatter
pnpm -r run format:check  # Check formatting without changes
pnpm run lint             # Run linting checks
pnpm run lint:fix         # Fix linting issues automatically

# Documentation
pnpm --filter @eudiplo/docs start  # Serve Docusaurus with live reload
pnpm --filter @eudiplo/docs build  # Build documentation
```

## General Guidelines

- Follow the coding standards in [Code Quality](./code-quality.md)
- Write tests for new features (see [Testing](./testing.md))
- Update documentation when changing behavior
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages
- All commits must be signed (see [Releases](./releases.md))

For detailed contribution guidelines, see the [CONTRIBUTING.md](https://github.com/openwallet-foundation/eudiplo/blob/main/CONTRIBUTING.md) file in the repository root.

## Contributions Welcome

Feel free to contribute by improving documentation, fixing bugs, or extending functionality. Make sure to follow the coding standards and write tests where applicable.
