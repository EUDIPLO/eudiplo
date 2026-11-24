---
title: Code Quality
---

# Code quality

Each package brings its own formatter and linter. The root scripts run them for every package: `pnpm format` writes, `pnpm format:check` only checks, `pnpm lint` lints and `pnpm lint:fix` fixes what it can.

| Package | Formatter | Linter | Configuration |
| --- | --- | --- | --- |
| Backend, CLI | Biome (`biome format`) | Biome (`biome lint`) | `biome.json` (TypeScript files of these two apps only) |
| Client | Prettier | ESLint (`ng lint`, angular-eslint) | `apps/client/.prettierrc`, `apps/client/eslint.config.js` |
| Documentation | — | markdownlint | `apps/docs/.markdownlint.json` |

Biome settings: 4-space indentation, 80-character lines, double quotes, semicolons, LF line endings; the linter only enforces `noUnusedImports` and `noUnusedVariables`. Generated files (`config-schemas.generated.ts`) are excluded. The client uses 2 spaces, single quotes and 100-character lines.

## Commands

```bash
pnpm format                                   # format every package
pnpm format:check                             # check only; CI runs this
pnpm lint                                     # lint every package, including markdownlint for the docs
pnpm --filter @eudiplo/backend lint:fix       # Biome check --fix for the backend
pnpm knip                                     # unused files, dependencies and exports
```

## In CI

The **Lint Codebase** job runs on every pull request:

- `pnpm run lint` and `pnpm run format:check`,
- `pnpm run check:env-example`: the live entries of `.env.example` must satisfy the backend's required variables,
- `pnpm --filter @eudiplo/docs run lint`,
- a license check of the production dependencies of backend and client (MIT, Apache-2.0, BSD, ISC, 0BSD, OFL-1.1),
- `pnpm knip`.

The **Check Config Schemas** job checks that the generated schemas match the code and that published schema versions were not changed ([Configuration schemas](./configuration-schemas.md)). [SonarCloud](https://sonarcloud.io/project/overview?id=EUDIPLO_eudiplo) analyzes the backend and client sources; its findings are good first contributions.

## Vulnerability scanner files

The `.oss-scanner/` folder holds the build image and the threat model for Anthropic's [OSS Scanner](https://red.anthropic.com/oss-scanner/), which builds the repository from that Dockerfile and reads the threat model before it looks for vulnerabilities. `Dockerfile.dockerignore` in that folder replaces the root `.dockerignore` for this build, so the tests, the documentation and `deployment/` reach the image. No CI job uses these files. Update `.oss-scanner/threat_model.md` when the [security model](../concepts/security-model.md), the public routes, the roles or the way the tests are run change.

## Git hooks

`pnpm install` installs two [Husky](https://typicode.github.io/husky/) hooks:

- `pre-commit` runs `pnpm -r run format && pnpm -r run lint`, so it can rewrite files you are committing.
- `pre-push` runs `pnpm run knip`.

## Editor setup

The repository's `.vscode/settings.json` enables format on save and runs the Biome quick fixes and import organization on save. Install the extensions the dev container uses: Biome (`biomejs.biome`), ESLint, Prettier and the Angular Language Service. For other editors, see [Biome editor integration](https://biomejs.dev/configuration/editors/).

## Style

- Backend code follows the placement and dependency rules in [Backend architecture](./backend-architecture.md).
- Prefer explicit names over comments; add a comment where the reason for the code is not obvious, for example a protocol requirement.
- Do not log secrets, keys or personal data. Session and HTTP logging have redaction settings; see [Logging](../operate/logging.md).
