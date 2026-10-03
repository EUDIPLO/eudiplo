---
title: Documentation
---

<!-- RESTRUCTURE: content that belongs elsewhere or needs restructuring in the next phase (remove this comment when done):
  - document the tooling added by the restructure: `docs/_generated/` (generator output, not published), the schema registry `scripts/schema-docs/registry.ts` with `<SchemaReference name="…" mode="table|body" />`, the sidebar orphan check in `pnpm --filter @eudiplo/docs test`, markdownlint MD040, `onBrokenAnchors: 'throw'`
  - once no page carries a RESTRUCTURE comment any more, drop `markdown.mdx1Compat.comments` from docusaurus.config.ts if HTML comments are not wanted
-->

# Contributing to Documentation

EUDIPLO documentation is built with [Docusaurus](https://docusaurus.io/) and includes both hand-written guides and auto-generated API references.

## General Contribution Guidelines

Thank you for considering contributing to EUDIPLO!

Please refer to the [CONTRIBUTING.md](https://github.com/openwallet-foundation/eudiplo/blob/main/CONTRIBUTING.md) file in the root of the repository for detailed guidelines on:

- Reporting issues
- Suggesting features
- Setting up the development environment
- Submitting pull requests

## Documentation Structure

Documentation lives in `apps/docs/docs/`:

- **Hand-written guides** — Architecture, deployment, getting started, migration guides
- **Auto-generated references** — API documentation from Swagger/OpenAPI specs, configuration tables, and CLI references
- **Configuration tables** — Generated from backend schemas and environment variables

## Local Documentation Development

To preview documentation locally with live reload:

```bash
pnpm --filter @eudiplo/docs start
```

This starts a development server at `http://localhost:3000` that automatically reloads when you edit Markdown files.

## Building Documentation

To build the documentation for production:

```bash
pnpm --filter @eudiplo/docs build
```

This generates:

1. **Docusaurus static site** — Main documentation
2. **Auto-generated references** — Configuration tables and CLI reference

### Regenerating Auto-Generated Content

Before building, regenerate auto-generated reference pages:

```bash
pnpm --filter @eudiplo/docs run prebuild
```

This script:

- Generates configuration tables from backend schemas
- Updates CLI command reference
- Refreshes environment variable documentation

## API Documentation

API documentation is auto-generated from Swagger/OpenAPI specs:

- Swagger UI is available at `/api/docs` when the backend is running
- OpenAPI spec JSON is available at `/api/docs-json`

The backend automatically includes Swagger annotations via NestJS decorators (`@ApiTags`, `@ApiOperation`, `@ApiResponse`).

## Documentation Versioning

EUDIPLO uses Docusaurus's built-in versioning system (replacing the old mike/MkDocs workflow).

### Creating a New Version

When releasing a new major version:

```bash
pnpm --filter @eudiplo/docs run docusaurus docs:version X.Y
```

This creates a snapshot of the current documentation in `apps/docs/versioned_docs/version-X.Y/`.

### Version Behavior

- **Current (`docs/`)** — The latest development version (from `main` branch)
- **Versioned (`versioned_docs/version-X.Y/`)** — Frozen snapshots for each major release
- **Latest** — The default version shown to users (configured in `docusaurus.config.ts`)

### Editing Versioned Documentation

- **To update current docs**: Edit files in `apps/docs/docs/`
- **To update a released version**: Edit files in `apps/docs/versioned_docs/version-X.Y/`
- **To update navigation**: Edit `apps/docs/sidebars.ts` (current) or `apps/docs/versioned_sidebars/version-X.Y-sidebars.json` (versioned)

## Deployment

Documentation is automatically deployed to GitHub Pages on every push to `main`:

1. CI generates the auto-generated references
2. Docusaurus builds the static site
3. Cloudflare Pages deploys the artifact

**Access URLs:**

- **Primary site**: [https://docs.eudiplo.dev/](https://docs.eudiplo.dev/)
- **Legacy documentation**: [https://openwallet-foundation.github.io/eudiplo/docs/latest/](https://openwallet-foundation.github.io/eudiplo/docs/latest/)

## Migration from MkDocs

:::note Historical Context
EUDIPLO previously used MkDocs with the Material theme and mike for versioning. The documentation is being migrated to Docusaurus for better integration with the TypeScript ecosystem and improved developer experience.

The old MkDocs sources in `docs/` are being progressively migrated to `apps/docs/docs/` with updated syntax and structure.
:::

## Documentation Style Guide

- Use clear, concise language
- Include code examples where helpful
- Use Docusaurus admonitions (:::note, :::tip, :::warning, :::danger) for callouts
- Link to related documentation pages
- Keep configuration examples up-to-date
- Test all code snippets before committing

## Structure

- Main documentation: `apps/docs/docs/`
- API documentation: Auto-generated from Swagger/OpenAPI specs
- The site is built using Docusaurus with versioning support
