# Contributing to EUDIPLO

Thanks for your interest in contributing to **EUDIPLO**! This file describes the process: issues, pull requests and commit rules. The technical guides (setup, architecture, tests, documentation, releases) are in the [Contributing section of the documentation](https://docs.eudiplo.dev/contributing) (`apps/docs/docs/contributing/`).

---

## Reporting issues

1. **Search** the existing [issues](https://github.com/EUDIPLO/eudiplo/issues) to avoid duplicates.
2. If there is none, **open a new issue** with:
   - a short description,
   - steps to reproduce,
   - the EUDIPLO version (image tag or commit) and your environment,
   - logs or screenshots, with secrets and personal data removed.

Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Suggesting enhancements

Open an issue with the `feature request` label and describe the problem you want to solve, the proposed solution and the alternatives you considered.

## Finding something to work on

- Issues labeled [`good first issue`](https://github.com/EUDIPLO/eudiplo/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).
- Findings on the [SonarCloud dashboard](https://sonarcloud.io/project/overview?id=openwallet-foundation_eudiplo) (code smells, bugs, security hotspots). They are self-contained and a good way to learn the codebase.
- For backend refactoring, the [refactoring plan](apps/backend/docs/refactoring-plan.md). Pick one bounded slice before you start.

---

## Getting started

Fork the repository, clone your fork and follow the [development setup](apps/docs/docs/contributing/development-setup.md). In short:

```bash
corepack enable
pnpm install
pnpm --filter @eudiplo/config-format build
pnpm --filter @eudiplo/sdk-core build
cp .env.example apps/backend/.env   # then set MASTER_SECRET, AUTH_CLIENT_ID and AUTH_CLIENT_SECRET

pnpm dev:backend   # http://localhost:3000
pnpm dev:client    # http://localhost:4200
```

No local Node.js? Use the dev container (`.devcontainer/`, see [.devcontainer/README.md](.devcontainer/README.md)).

Generated code:

- `pnpm gen:api` regenerates the JSON schemas from the backend schemas. It runs automatically before the client's `dev`, `build` and `test`, and needs no running backend.
- `pnpm gen:sdk` regenerates `@eudiplo/sdk-core` from the OpenAPI spec of a **running** backend (`http://localhost:3000/api/docs-json`). Run it after changing a management endpoint or DTO.
- `pnpm gen:all` runs both.

Where to read next:

- Backend: [backend architecture](apps/docs/docs/contributing/backend-architecture.md) (where code goes, boundaries, how to add an endpoint, migration or env var).
- Tests: [testing](apps/docs/docs/contributing/testing.md). The backend E2E suite runs locally with `pnpm --filter @eudiplo/backend test:e2e:local`.
- Formatting and linting: [code quality](apps/docs/docs/contributing/code-quality.md).

---

## Commits

### Sign-off and signatures

Every commit must

- carry a **DCO sign-off** (`Signed-off-by:` trailer), certifying the [Developer Certificate of Origin](https://developercertificate.org/). Add it with `git commit -s`;
- be **cryptographically signed** (GPG, SSH or S/MIME) so GitHub shows it as verified. Configure signing once, for example with `git config --global commit.gpgsign true`, or commit with `git commit -S -s`.

To fix the last commit: `git commit --amend -S -s --no-edit`. For several commits: `git rebase --signoff -S <base>`.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). semantic-release derives the next version from them:

| Commit | Release |
| --- | --- |
| `fix: …`, `perf: …`, `refactor: …` | patch |
| `feat: …` | minor |
| a `BREAKING CHANGE:` footer (with `!` in the header) | major |
| `docs: …`, `test: …`, `chore: …`, `ci: …`, `build: …` | no release |

A **breaking change** is anything that makes an existing installation, integration or configuration stop working: removed or renamed API fields and endpoints, changed defaults, new required environment variables, stricter validation, changed configuration file formats. For a breaking change:

1. Mark the header with `!` **and** add a `BREAKING CHANGE:` footer that states what changed and what users must do. The footer is what triggers the major release (the Angular preset used by semantic-release does not parse `!`) and appears in the release notes.

   ```text
   fix(verifier)!: report failed presentations to webhooks

   BREAKING CHANGE: presentation webhooks also fire for failed and declined
   presentations; consumers must check the new `status` field.
   ```

2. Add the change to the upgrade guide of the next major version in `apps/docs/docs/upgrade/` (what changed and what to do). A breaking change without an upgrade note is not merged.
3. Fill in the "Breaking Changes" section of the pull request and add the `breaking-change` label.

---

## Pull requests

Create pull requests against `main` and keep each one focused on a single topic.

Checklist:

- [ ] Every commit is signed off (`-s`) and signed (`-S`).
- [ ] Commit messages follow Conventional Commits; breaking changes use `!` and a `BREAKING CHANGE:` footer.
- [ ] Code builds, and the tests of the touched packages pass (`pnpm test` or the package's `test` script; E2E for protocol, wiring or persistence changes).
- [ ] `pnpm run lint` and `pnpm run format:check` pass.
- [ ] Generated files are regenerated and committed (`pnpm gen:api`, `pnpm gen:sdk`, schema snapshots).
- [ ] The documentation page that owns the changed behavior is updated, and breaking changes have an upgrade note.

CI runs linting, formatting, builds, unit and E2E tests, the OIDF conformance tests and the documentation build on every pull request.

---

## Documentation contributions

The documentation is a Docusaurus site in `apps/docs/`:

```bash
pnpm --filter @eudiplo/docs run prebuild   # generate reference content (once)
pnpm --filter @eudiplo/docs start          # live reload on http://127.0.0.1:3003
pnpm --filter @eudiplo/docs build          # production build; fails on broken links
```

Content is organized into cookbooks, guides (`issuance/`, `presentation/`, `trust/`, `operate/`), reference, concepts, contributing and upgrade. The rules for page types, generated references and checks are in the [documentation guide](apps/docs/docs/contributing/documentation.md).

---

## Community and conduct

We follow a [Code of Conduct](CODE_OF_CONDUCT.md). Please be kind and constructive.

## Need help?

Open a discussion or issue on [GitHub](https://github.com/EUDIPLO/eudiplo/issues), join the [Discord](https://discord.gg/58ys8XfXDu), or contact the [maintainers](MAINTAINERS.md).

Thanks for helping improve EUDIPLO!
