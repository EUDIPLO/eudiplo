---
mode: agent
description: Implement one EUDIPLO architecture-hardening task completely
---

Only execute when the user explicitly requests implementation of a named task or bounded slice. A review or documentation merge does not authorize implementation. If no task is selected, ask which task to implement.

Implement the requested slice from the "Next slices" and "Open review findings" sections of
[the refactoring plan](../../apps/docs/docs/architecture/refactoring-plan.md).

Use
[the target backend architecture](../../apps/docs/docs/architecture/backend-architecture.md)
and the repository Copilot instructions as authoritative guidance.

Before changing code:

1. Inspect the current implementation and all relevant callers.
2. Identify existing abstractions that already solve part of the problem.
3. Identify obsolete abstractions or compatibility layers that should be removed.
4. Determine the smallest coherent architectural boundary that can be completed in this task.
5. Check whether the area is protocol/trust core or administrative CRUD ("Scope" in the architecture doc); CRUD does not need extra layers.
6. Reuse the patterns listed under "Reference implementations" in the architecture doc.
7. Write characterization tests for the current behavior first. Mock third-party libraries with their real error shapes (for example `Oauth2ServerErrorResponseError` with `errorResponse`), not invented ones.

While implementing:

- Complete the refactor rather than only making the code compile.
- Breaking internal APIs are allowed.
- Prefer cleaner long-term architecture over preserving obsolete internal APIs.
- Update all affected callers.
- Keep external protocol behaviour compatible unless the task explicitly requires a change.
- Add or update architecture/boundary tests.
- Add or update unit tests.
- Prefer domain-specific ports over generic wrappers.
- Do not create temporary compatibility wrappers unless they are genuinely necessary.
- Do not implement unrelated backlog tasks.

After implementing:

1. Run the relevant unit tests.
2. Run type checking.
3. Run linting and the backend `format:check` script.
4. Run architecture/boundary tests. If debt was removed, regenerate the ratchet baseline with `UPDATE_ARCHITECTURE_BASELINE=1 pnpm --filter @eudiplo/backend test` and check that it only shrank.
5. Run the affected E2E suites (`pnpm --filter @eudiplo/backend test:e2e:local`, optionally with test file paths).
6. Add a DI wiring test for classes registered with `useFactory`, and use conditional updates for anything single use.
7. Fix regressions caused by the refactor.
8. Update the task table, known debt and findings in `refactoring-plan.md`.
9. Summarize:
   - architectural changes made
   - files/modules affected
   - tests executed
   - remaining technical debt
   - follow-up task that should be implemented next

Keep changes within the selected slice. Characterize current behavior before extraction; add the required models, error mapping, DI wiring, and contract tests with the slice. Preserve public API/configuration compatibility, tenant isolation, atomic operations, and security checks. Record unavailable checks honestly; do not silently broaden scope to change external behavior.
