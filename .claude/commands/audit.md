---
description: Audit an area of the current checkout (not a diff) with the relevant reviewers, verify every finding adversarially, and write a report with candidate issues
argument-hint: "<area> [goal: <attacker goal>]   areas: auth crypto issuer-config oid4vci status-list trust oid4vp session platform webhook cli client config-format sdk docs deployment release, or a path"
---

Audit an area of the repository as it is on the checked-out commit, verify the findings, and produce a report. Nothing is edited and no issue is created; the user decides what to file.

Arguments: `$ARGUMENTS`. The first word is the area; an optional `goal: …` suffix is an attacker goal for the security reviewer.

## Areas

| Area | Paths | Reviewers |
| --- | --- | --- |
| `auth` | `apps/backend/src/auth` | security, quality, docs-alignment, compat |
| `crypto` | `apps/backend/src/crypto` | security, spec-compliance, quality, docs-alignment, compat |
| `issuer-config` | `apps/backend/src/issuer/configuration` | security, quality, docs-alignment, compat |
| `oid4vci` | `apps/backend/src/issuer/issuance` | security, spec-compliance, quality, docs-alignment, compat |
| `status-list` | `apps/backend/src/issuer/status-list` | security, spec-compliance, quality, docs-alignment, compat |
| `trust` | `apps/backend/src/trust`, `apps/backend/src/issuer/trust-list` | security, spec-compliance, quality, docs-alignment, compat |
| `oid4vp` | `apps/backend/src/verifier` | security, spec-compliance, quality, docs-alignment, compat |
| `session` | `apps/backend/src/session`, `apps/backend/src/audit-log` | security, quality, docs-alignment, compat |
| `platform` | `apps/backend/src/platform`, `apps/backend/src/core`, `apps/backend/src/database`, `apps/backend/src/storage`, `apps/backend/src/shared` | security, quality, docs-alignment, compat |
| `webhook` | `apps/backend/src/webhook`, `apps/backend/src/registrar` | security, quality, docs-alignment, compat |
| `cli` | `apps/cli` | security, quality, docs-alignment, compat |
| `client` | `apps/client` | ux, security, quality, docs-alignment |
| `config-format` | `packages/eudiplo-config-format`, `schemas` | compat, quality, docs-alignment |
| `sdk` | `packages/eudiplo-sdk-core` | compat, quality, docs-alignment |
| `docs` | `apps/docs/docs` | docs-alignment |
| `deployment` | `deployment`, `docker-compose.yml`, `Dockerfile`, `Dockerfile.release`, `monitor` | security, docs-alignment, compat |
| `release` | whole repository since the last release tag | compat |

Any other argument is treated as a path and reviewed by all six reviewers (ux only if it is under `apps/client`, spec-compliance only if it is under `apps/backend/src/issuer`, `verifier`, `trust` or `crypto`).

## Steps

1. Resolve the area to paths and reviewers from the table. Record `git rev-parse --short HEAD` and `git describe --tags --abbrev=0 origin/main`. Do not read the area yourself; stay unbiased for the merge.

2. Load the ledger: `gh issue list --label audit --state all --limit 200 --json number,title,state,url,body`. If the label does not exist, say so once and continue with an empty ledger. Known findings are open issues (reported before) and issues closed as not planned (accepted); issues closed as completed count as fixed and a recurrence is new.

3. Spawn the area's reviewers in parallel, in one message, `run_in_background: false`, with this prompt and nothing else:

   > audit <area>. Paths: <comma-separated paths>. Follow the audit mode of your own instructions.

   For the security reviewer append ` Goal: <goal>` when one was given. Pass no hypotheses and no other reviewer's output.

4. Collect every finding (not the "checked and clean" entries). Verify the ones that would become an issue: every security and spec-compliance finding, every docs mismatch, every compatibility finding, and from the quality and UX reviewers the findings that name a concrete defect or a concrete missing test (not the long tails of "untested file" lists or style items; group those under one candidate issue and mark it "not verified individually"). For each selected finding spawn one `finding-verifier` with the finding verbatim and the name of the reviewer, in parallel, at most eight at a time. Use `model: opus` for findings from the security and spec-compliance reviewers, `inherit` for the rest. List the unverified findings in the report under "Reported but not verified".

5. Merge:
   - Keep CONFIRMED and UNVERIFIABLE findings; move REFUTED ones to an appendix with the verifier's reason.
   - Mark a finding as known when a ledger issue names the same file and the same claim; link the issue.
   - Order: security critical and high, non-conformant protocol behavior, breaking changes without migration path, then by severity within each reviewer.

6. Write the report to `tmp/audit/<area>-<YYYY-MM-DD>.md` (create the folder; `tmp/` is git-ignored) with this structure, and print the summary section in the chat:

   ```
   # Audit: <area> at <commit> (<date>)

   Reviewers: <list>. Findings: <n> reported, <n> confirmed, <n> unverifiable, <n> refuted, <n> known.

   ## Summary
   <one line per confirmed or unverifiable new finding: severity, claim, file:line>

   ## Candidate issues
   For each new confirmed finding, a ready-to-file issue:
   ### <title>
   Labels: audit, <security|spec|docs|compat|quality|ux>
   <body: claim, scenario, independent trace from the verifier, fix, reviewer and verifier verdicts>

   ## Known findings
   <finding → issue link>

   ## Unverifiable
   <finding → what would settle it>

   ## Reviewer reports
   <each report verbatim under its own heading>

   ## Appendix: refuted
   <finding → verifier reason>
   ```

7. Write one body file per candidate issue to `tmp/audit/<area>-<date>-issues/NN-<slug>.md` and a `create-all.sh` next to them. Rules for the commands: single-quote the title, keep backticks and `$` out of titles (the shell expands them), and use only labels that exist (`gh label list`; this repository has `security`, `documentation`, `testing`, `frontend`, `compliance`, `backend`, `audit`). End with the commands. Do not run them unless the user asks.
