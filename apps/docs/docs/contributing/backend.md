---
title: Backend Development
---

# Backend Development

The backend uses NestJS modules grouped by business capability. The structure is deliberately pragmatic: code that changes together stays together, while cross-cutting infrastructure has an explicit home.

## Target Architecture and Refactoring

The [target backend architecture](../architecture/backend-architecture.md) defines the intended application, domain, port, and adapter boundaries. Existing code is being migrated incrementally; the [refactoring plan](../architecture/refactoring-plan.md) tracks what is done and what comes next. It is not an instruction to execute tasks automatically.

Follow the placement rules below and apply the target boundaries within each selected slice. Include the necessary models, error mapping, composition, and tests with that slice.

## Directory Map

```text
apps/backend/src/
├── app.module.ts          # Application composition root
├── core/                  # Health, application metadata, global interceptors
├── platform/              # Configuration, import, encryption, observability
├── shared/                # Feature-independent filters and small utilities
├── auth/                  # Authentication, clients, users, tenants, roles
├── crypto/                # Key and cryptographic operations
├── database/              # TypeORM setup and migrations
├── issuer/                # Issuer configuration, issuance, status lists
├── registrar/             # Registrar configuration and schema metadata
├── session/               # Session lifecycle, events, and session logging
├── storage/               # File persistence
├── trust/                 # Trust lists, federation, certificate validation
├── verifier/              # Presentation and credential verification
├── webhook/               # Outbound webhooks and URL policy
└── audit-log/             # Administrative audit log
```

## Placement Rules

Use the narrowest owner that describes the code:

1. Put protocol and business behavior in its feature directory. For example, status-list behavior belongs in `issuer/status-list/`, not in `shared/`.
2. Put application-wide technical capabilities in `platform/`. Configuration loading, data-at-rest encryption, and logging setup are platform concerns.
3. Put code in `shared/` only when it is feature-independent, stateless or narrowly scoped, and safe to import from any feature. `shared/` must not import from application features.
4. Give every injectable provider one owning module. Other features import that module and use its exports instead of registering the provider again.
5. Keep controllers, DTOs, entities, validation schemas, and services close to their feature. Split a module when its providers form a distinct capability with a clear public API.

## Module Dependencies

`AppModule` is the composition root. It initializes global framework modules and imports the top-level application modules.

Within the application:

- import another NestJS module when using its exported providers;
- do not copy a foreign provider into a module's `providers` array;
- avoid `forwardRef()` unless two modules have a real runtime cycle that cannot first be removed by changing ownership or extracting a smaller service;
- keep feature imports out of `shared/`;
- export only the providers or submodules that consumers actually require.

The boundary test in `apps/backend/src/platform/module-boundaries.spec.ts` protects the `shared/` dependency rule, prevents old catch-all directories from returning, and enforces migrated application/domain/port boundaries. See [current enforcement and legacy exceptions](../architecture/backend-architecture.md#current-boundary-enforcement) before extracting a new use case.

## Feature Module Shape

See [Feature folder shape](../architecture/backend-architecture.md#feature-folder-shape) for the folder layout, error mapping, and wiring rules. A feature does not need every folder: small, feature-specific helpers can stay next to the code that uses them. Extract a use case or service when the behavior has its own dependencies, lifecycle, or focused tests.

## Adding or Moving Backend Code

Before opening a pull request:

- identify the feature or platform capability that owns the behavior;
- import the owning module rather than re-registering its provider;
- add focused unit tests beside extracted services;
- update imports, E2E utilities, generation scripts, and documentation paths;
- run the backend format check, build, lint, and unit tests;
- run relevant E2E tests when module wiring or protocol behavior changes.

From the repository root, the main backend checks are:

```bash
pnpm --filter @eudiplo/backend run format:check
pnpm --filter @eudiplo/backend run build
pnpm --filter @eudiplo/backend run lint
pnpm --filter @eudiplo/backend run test
```

When moving TypeORM entities, confirm that migration discovery and any data source imports still resolve. A source-code move alone should not create a database migration unless the persisted schema also changes.

## Related Documentation

- [Development Setup](./development-setup.md) — Environment configuration and running locally
- [Repository Structure](./repository-structure.md) — Monorepo layout and workspace conventions
- [Testing](./testing.md) — Writing and running unit tests
- [E2E Testing](./e2e-testing.md) — Integration and end-to-end test workflows
