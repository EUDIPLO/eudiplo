# EUDIPLO

Contributor rules: `CONTRIBUTING.MD` and `apps/docs/docs/contributing/`. Architecture direction: `.github/copilot-instructions.md`. Read the relevant guide before changing code.

## Reviews

Run `/review` before opening a pull request. It spawns six independent, read-only reviewers in parallel: `security-reviewer`, `spec-compliance-reviewer`, `docs-alignment-reviewer`, `compat-reviewer`, `quality-reviewer` and `ux-reviewer` (`.claude/agents/`). Each has its own scope and must receive only the target of the review, never your own conclusions or another reviewer's output. Fix findings afterwards in the main session, not inside a reviewer. `/audit <area>` runs the same reviewers over the current state of one area and verifies every finding with `finding-verifier` before it is reported; see `.claude/README.md`.

### Reviews without being asked

When you have finished a change you made in this session, and before you commit it, spawn the reviewers that match what it touches, in parallel, on the uncommitted changes. Do this without waiting to be asked; skip it only when the user says so for this change.

| The change touches | Reviewer |
| --- | --- |
| Auth, roles, tenant isolation, outbound HTTP, OAuth, OID4VCI or OID4VP flows, keys or KMS, status or trust lists, input validation, logging | `security-reviewer` |
| Wallet-facing protocol behavior: OID4VCI, OID4VP, HAIP, OpenID Federation, DPoP, PAR, PKCE, SD-JWT VC, mdoc, Token Status List, ETSI trust lists | `spec-compliance-reviewer` |
| An endpoint or DTO, a default, validation, an environment variable, `packages/eudiplo-config-format`, the database schema, `packages/eudiplo-sdk-core` or `apps/cli` | `compat-reviewer` and `docs-alignment-reviewer` |
| `apps/docs` or any other user-visible behavior | `docs-alignment-reviewer` |
| Any behavior change in code | `quality-reviewer` |
| `apps/client` | `ux-reviewer` |

When unsure whether a row applies, run that reviewer. Skip the whole step for changes without behavior: typos, comments, formatting, lockfile-only dependency bumps, and files under `.claude/` or `tmp/`.

Give each reviewer only the target, for example "Review this change set: uncommitted changes in the working tree of <branch>.", as for `/review`. Check every finding against the code; fix the ones that hold up before committing, and list the rest in your reply with the reason you left them. After a fix, re-run only the reviewer that raised it, once.

## Commits

Every commit is signed off (`git commit -s`, DCO) and cryptographically signed. Conventional Commits decide the version: a breaking change needs `!` in the header, a `BREAKING CHANGE:` footer and a section in `apps/docs/docs/upgrade/` for the next major.
