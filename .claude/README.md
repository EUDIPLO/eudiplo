# Claude Code setup for EUDIPLO

This folder holds the project's Claude Code configuration: six read-only reviewer agents and a finding verifier in `agents/`, and the `/review` and `/audit` commands in `commands/`. The rules Claude follows in every session are in the repository root `CLAUDE.md`.

## Commands

| Command | What it does |
| --- | --- |
| `/review` | Runs all six reviewers in parallel on the working tree and unpushed commits against `origin/main`, then prints one merged report. |
| `/review 1180` | Same for pull request 1180. |
| `/review fix/some-branch` | Same for a branch. |
| `/audit oid4vp` | Audits an area of the current checkout, not a diff: the relevant reviewers read the whole area, every finding goes through `finding-verifier`, and the report with ready-to-file issues lands in `tmp/audit/<area>-<date>.md`. Areas: `auth`, `crypto`, `issuer-config`, `oid4vci`, `status-list`, `trust`, `oid4vp`, `session`, `platform`, `webhook`, `cli`, `client`, `config-format`, `sdk`, `docs`, `deployment`, `release`, or a path. |
| `/audit trust goal: reach an internal host from a tenant configuration` | Same, with an attacker goal the security reviewer pursues before its checklist. |
| `/audit release` | Classifies everything since the last release tag and checks the next major's upgrade guide covers it. |
| `/code-review`, `/code-review high` | Built-in correctness review by one reviewer; quicker and cheaper than `/review`. |
| `/security-review` | Built-in security review of the pending changes. The `security-reviewer` agent adds the EUDIPLO-specific checklist on top. |
| `/simplify` | Built-in reuse, simplification and efficiency pass that also applies the fixes. Our `quality-reviewer` leaves generic clean-code findings to this. |
| `/agents` | Lists and manages the agents (interactive `claude` terminal only). |

## Talking to one reviewer

Ask for the agent by name in plain language; Claude spawns it with its own context:

- "Run the compat-reviewer on PR 1180."
- "Use the spec-compliance-reviewer on the OID4VP request-object changes in the working tree."
- "Let the ux-reviewer look at apps/client/src/app/presentation."

Give it only the target. Do not tell it what you expect it to find; an agent handed a hypothesis tends to confirm it.

## Audit ledger

`/audit` deduplicates against GitHub issues labeled `audit` (create the label once with `gh label create audit`). An open issue means "reported", closed as not planned means "accepted", closed as completed means "fixed" and a recurrence is new. The command never files issues itself; it prints the `gh issue create` commands for the confirmed findings. Run one area per week, for example on a schedule, and a full pass before a major release.

## Reviews without being asked

Claude runs the matching reviewers on its own before it commits a change it made, following the trigger table in the root `CLAUDE.md` (for example `security-reviewer` for auth or outbound HTTP, `ux-reviewer` for `apps/client`). Say "skip the review" to turn it off for one change. `/review` with all six reviewers is still the step before a pull request.

## After a review

The reviewers never edit files. Fix findings in the main session, for example "Fix finding 2 of the compatibility review" or "Add the regression test the quality reviewer asked for". Re-run a single reviewer afterwards instead of the whole `/review`.

## Headless use

```bash
claude -p "/review 1180"
```

prints the merged report to stdout, for example to attach it to a PR comment.

## Agents

| Agent | Scope | Model |
| --- | --- | --- |
| `security-reviewer` | Authorization and tenancy, outbound URL policy, OAuth/OID4VP binding, resource bounds, secrets | opus |
| `spec-compliance-reviewer` | Conformance to the specifications on the protocols reference page (OIDF, IETF, ISO, ETSI); quotes the normative text | opus |
| `docs-alignment-reviewer` | Code and `apps/docs` describe the same system | inherit |
| `compat-reviewer` | Breaking-change classification, DB and config-format migration path, release follow-ups | inherit |
| `quality-reviewer` | Untested behavior, tests that cannot fail, architecture boundaries and ratchet | inherit |
| `ux-reviewer` | Angular client states, forms, destructive actions, consistency, accessibility, Playwright coverage | inherit |
| `finding-verifier` | Tries to disprove one finding with independent evidence; CONFIRMED, REFUTED or UNVERIFIABLE | inherit (opus for security and spec findings in `/audit`) |

Every reviewer accepts two targets: a change set (`/review`) or `audit <area>` with paths (`/audit`), described in its "Audit mode" section. You can also verify a single finding by hand: "Run the finding-verifier on finding 3 of the security review."

Every agent reports `Out of scope, noticed` lines for things it saw but does not own; another reviewer or the main session picks those up. To add a reviewer, copy one of the files, keep the frontmatter shape (`name`, `description`, `tools`, `model`) and add it to the list in `commands/review.md` and to the list and the trigger table in `CLAUDE.md`.
