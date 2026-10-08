---
description: Run the six independent reviewers (security, spec compliance, docs alignment, compatibility, quality, UX) on a change set and merge their reports
argument-hint: "[PR number | branch] (empty: working tree and unpushed commits vs origin/main)"
---

Run an independent six-way review of a change set and merge the results.

Target: `$ARGUMENTS` (empty means the working tree plus unpushed commits of the current branch against `origin/main`).

## Steps

1. Resolve the target to one sentence that names it unambiguously, for example "pull request 1180", "branch fix/foo against origin/main" or "working tree and unpushed commits of <branch> against origin/main". Run `git status --short` and `git log origin/main..HEAD --oneline` once so the summary at the end can state the scope. Do not read the diff yourself before the agents report; your job in this step is to stay unbiased.

2. Spawn the six reviewers in parallel, in one message, with `run_in_background: false`:
   - `security-reviewer`
   - `spec-compliance-reviewer` (returns "no protocol-relevant changes" quickly when the diff touches nothing wallet-facing)
   - `docs-alignment-reviewer`
   - `compat-reviewer`
   - `quality-reviewer`
   - `ux-reviewer` (returns "no client changes" quickly when the diff does not touch `apps/client` or an endpoint the client calls)

   Give each agent exactly the same prompt and nothing more:

   > Review this change set: <target sentence>. Follow your own instructions for how to obtain the diff and what to report.

   Do not add hypotheses, do not mention what you expect them to find, do not forward one agent's report to another, and do not tell them about earlier review rounds. Independence is the point of this command.

3. When all six have returned, print one report with these sections, each agent's findings verbatim under its own heading and in its own order:

   ```
   # Review of <target>

   Scope: <files changed, commits>

   ## Security (security-reviewer)
   <report>

   ## Spec compliance (spec-compliance-reviewer)
   <report>

   ## Docs alignment (docs-alignment-reviewer)
   <report>

   ## Compatibility (compat-reviewer)
   <report>

   ## Quality and tests (quality-reviewer)
   <report>

   ## User experience (ux-reviewer)
   <report>

   ## Overlaps
   <lines or files that two or more agents flagged, one bullet each, with both views>

   ## Suggested order of work
   <numbered list: blockers first (security critical/high, non-conformant protocol behavior, breaking without migration path, UX blockers), then untested behavior and doc mismatches, then the rest>
   ```

4. Do not fix anything as part of this command. If the user wants fixes, they will ask; then start from the merged report, not from a re-review.
