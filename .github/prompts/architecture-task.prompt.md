---
mode: agent
description: Implement one EUDIPLO architecture-hardening task completely
---

Only execute when the user explicitly requests implementation of a named task or bounded slice. A review or documentation merge does not authorize implementation. If no task is selected, ask which task to implement.

Implement the requested task from
[the architecture hardening backlog](../../apps/docs/docs/architecture/refactoring-plan.md).

Use
[the target backend architecture](../../apps/docs/docs/architecture/backend-architecture.md)
and the repository Copilot instructions as authoritative guidance.

Before changing code:

1. Inspect the current implementation and all relevant callers.
2. Identify existing abstractions that already solve part of the problem.
3. Identify obsolete abstractions or compatibility layers that should be removed.
4. Determine the smallest coherent architectural boundary that can be completed in this task.

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
4. Run architecture/boundary tests.
5. Run focused integration tests where relevant.
6. Fix regressions caused by the refactor.
7. Summarize:
   - architectural changes made
   - files/modules affected
   - tests executed
   - remaining technical debt
   - follow-up task that should be implemented next

Keep changes within the selected slice. Characterize current behavior before extraction; add the required models, error mapping, DI wiring, and contract tests with the slice. Preserve public API/configuration compatibility, tenant isolation, atomic operations, and security checks. Record unavailable checks honestly; do not silently broaden scope to change external behavior.
