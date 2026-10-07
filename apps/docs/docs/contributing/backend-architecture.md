---
title: Backend Architecture
---

# Backend architecture

This page says where backend code goes, which boundaries the tests enforce, and how to add an endpoint, a migration, an environment variable or an adapter. The rules for each role (what controllers, use cases, ports and adapters may and may not do, forbidden dependencies) are in [`.github/instructions/backend-architecture.instructions.md`](https://github.com/EUDIPLO/eudiplo/blob/main/.github/instructions/backend-architecture.instructions.md). Migration status, known debt and the next slices are in the [refactoring plan](https://github.com/EUDIPLO/eudiplo/blob/main/apps/backend/docs/refactoring-plan.md); it is not an instruction to execute tasks automatically.

EUDIPLO's backend is a NestJS modular monolith that is migrating incrementally toward ports and adapters. Apply the boundaries to new or explicitly migrated code. Preserve public HTTP and protocol contracts, configuration formats, persisted data and security behavior unless the change explicitly targets them.

## Scope: where the layering applies

| Area | Expected shape | Why |
| --- | --- | --- |
| Protocol and trust core: OID4VCI, OID4VP, authorization, credential formats, trust evaluation, sessions | Use cases in `application/`, rules in `domain/`, infrastructure behind `ports/` | Security-critical branching that must be testable without HTTP or a database; real extension points (formats, claims providers, trust sources, KMS, storage). |
| Administrative CRUD: tenant, client, credential/issuance/presentation configuration, status-list configuration, registrar configuration, audit log, config import/export | A feature service with an injected TypeORM repository | Read, validate and save have little logic; extra layers add ceremony. |

CRUD services keep DTO validation in the controller, scope every query to the tenant, throw `NotFoundError` subclasses or Nest HTTP exceptions and contain no protocol logic. When a CRUD service gains business rules or becomes a dependency of the protocol core, extract a port for what the core needs. The migration is done when the protocol and trust core follows the target shape and the ratchet baseline has no core entries.

## Dependency direction

```text
Inbound adapter → Application / use case → Domain
                          ↓
                    Outbound port
                          ↑
                 Infrastructure adapter
```

Arrows are source dependencies, not call order. The application owns its outbound ports; adapters depend inward on them. Nest modules are composition roots that bind ports to adapters. The code stays capability-oriented (`issuer/`, `verifier/`, `trust/`, …); there are no global `domain/` or `application/` folders.

| Role | Responsibility and placement |
| --- | --- |
| Controller / inbound adapter | Parse transport input, call a use case, map results and errors. |
| Use case / application service | Coordinate one workflow through domain rules and ports. |
| Domain model / service | Infrastructure-independent rules and state. |
| Port | Application-owned contract for a required capability, next to its consumers. |
| Adapter | Implements a port with persistence, HTTP or an SDK. |
| Repository | Port with aggregate operations, explicit tenant scope and atomicity. |
| Entity | TypeORM representation; confined to persistence and composition. |
| DTO | API shape with validation and Swagger metadata; mapped at the boundary. |

## Feature folder shape

This is the single reference for where backend code goes. A feature only creates the folders it needs.

```text
feature/
├── feature.module.ts          # composition root: binds ports to adapters, typed settings
├── feature.controller.ts      # inbound adapter: DTO parsing, HTTP/protocol error mapping
├── feature-settings.ts        # typed capability settings + injection token
├── dto/                       # API shapes (validation, Swagger)
├── entities/                  # TypeORM entities (adapter role)
├── application/               # use cases, application errors (checked)
├── domain/                    # models, rules, domain errors (checked)
├── ports/                     # outbound contracts + injection tokens (checked)
├── adapters/                  # TypeORM repositories, HTTP/SDK clients, schedulers (*.job.ts)
└── feature.service.ts         # legacy/mixed service still being migrated
```

- **Errors.** Application and domain code throw plain `Error` subclasses. A missing resource extends `NotFoundError` from `shared/domain/not-found-error.ts`, which `AllExceptionsFilter` maps to 404. Other application errors are mapped by the controller or protocol service that calls the use case.
- **Wiring.** A framework-free class with constructor dependencies is registered with a `useFactory` provider that lists its `inject` tokens. As a bare class provider without `@Injectable()`, Nest constructs it with `undefined` dependencies.
- **Request data.** Services receive plain values, never the Express `Request`. For audit metadata, controllers use the `@AuditMeta()` parameter decorator and pass an `AuditLogRequestMeta`.
- **Single use is a conditional update.** Codes, nonces, `request_uri`s and presentation responses are consumed with one conditional write (for example `SessionStore.updateIfUnconsumed` or `consumeRequestUri`) whose result decides who wins. Never read a flag and write it later.
- **Adapters are not a parking place.** `adapters/` is only checked for HTTP exceptions and imports of controllers, modules and other capabilities' adapters, so it must only hold port implementations.
- **Configuration.** Core code receives typed settings (for example `session/session-settings.ts` with its `SESSION_SETTINGS` token), not `ConfigService`.

## Reference implementations

Copy the patterns from these migrated areas when starting a new slice:

| Pattern | Where to look |
| --- | --- |
| Repository port, TypeORM adapter, shared SQLite/PostgreSQL contract test | `session/ports/session.repository.ts`, `session/adapters/typeorm-session.repository.ts`, `apps/backend/test/session/session-repository.contract.ts` |
| Application service for lookups and atomic single-use updates | `session/application/session-store.ts` |
| Use case with events and metrics behind ports | `session/application/change-session-state.ts` |
| Protocol use cases with a transport-neutral error mapped in the controller | `issuer/issuance/oid4vci/authorization/application/`, `domain/oauth-error.ts`, `authorize/authorize.controller.ts` |
| Characterization tests written before refactoring | `issuer/issuance/oid4vci/authorization/authorize/authorize.controller.spec.ts`, `verifier/oid4vp/presentation-verification.spec.ts` |
| Format registry and adapters | `issuer/configuration/credentials/` (issuance), `verifier/presentations/domain/credential-verifier-format.ts` and `verifier/presentations/adapters/` (verification) |
| External metadata behind a port with cache and HTTP adapter | `issuer/issuance/oid4vci/ports/authorization-server-metadata.ts`, `adapters/http-external-authorization-server-metadata-resolver.ts` |
| DI wiring test for factory-registered classes | `trust/trust-module-wiring.spec.ts`, `issuer/issuance/oid4vci/authorization/authorization-module-wiring.spec.ts` |
| Administrative CRUD without extra layers | `verifier/presentations/configuration/presentation-config.service.ts` |

## Capability map

```text
apps/backend/src/
├── app.module.ts      # composition root
├── core/              # health, service info and version, global interceptors
├── platform/          # configuration (Joi schemas), config import/portability, data encryption, observability
├── shared/            # feature-independent helpers; must not import features
├── auth/              # management authentication, clients, users, tenants, roles
├── crypto/            # key chains, KMS adapters (crypto/key/kms/adapters/)
├── database/          # TypeORM setup and migrations
├── issuer/
│   ├── configuration/ # credential and issuance configs, format registry, attribute providers, webhook endpoints
│   ├── issuance/
│   │   ├── offer/     # credential offer management API
│   │   └── oid4vci/   # OID4VCI: application/, domain/, ports/, adapters/, metadata, well-known
│   │       └── authorization/  # built-in, chained, OID4VP-based and interactive authorization
│   ├── status-list/   # Token Status List
│   └── trust-list/    # managed trust lists
├── verifier/
│   ├── presentations/ # presentation configs, verifier format registry and adapters, credential checks
│   ├── oid4vp/        # OID4VP request objects and responses
│   ├── verifier-offer/# presentation request API
│   ├── iso18013/      # ISO 18013-7 (mdoc over the DC API)
│   └── resolver/      # key resolution for verification
├── registrar/         # registrar configuration and schema metadata
├── session/           # session lifecycle, events, retention, session logs
├── storage/           # file storage (local, S3)
├── trust/             # trust store, LoTE lists, OpenID Federation, X.509 validation
├── webhook/           # outbound webhooks and the outbound URL policy
└── audit-log/         # administrative audit log
```

Placement rules: put protocol and business behavior in its feature directory; put application-wide technical capabilities in `platform/`; put code in `shared/` only when it is feature-independent and safe to import from anywhere. Every injectable provider has one owning module; other features import that module instead of registering the provider again. Avoid `forwardRef()` unless a real runtime cycle cannot be removed by changing ownership.

## How to add …

### A management endpoint

1. Add the handler to the feature controller. Controllers are served under the global `/api` prefix, so `@Controller("session")` becomes `/api/session`.
2. Protect it with `@Secured([Role.…])` (`auth/secure.decorator.ts`, roles in `auth/roles/role.enum.ts`) and take the tenant from `@Token()`. Never trust a tenant id from the request body.
3. Validate input with a DTO and describe it with Swagger decorators (`@ApiTags`, `@ApiOperation`, `@ApiResponse`); the OpenAPI spec at `/api/docs-json` and the SDK are generated from them.
4. Put the logic in the owning service or use case, not in the controller.
5. Add unit tests and an E2E test (`apps/backend/test/<area>/*.e2e-spec.ts`), then regenerate the SDK with the backend running (`pnpm gen:sdk`) and commit the result.

### A wallet-facing or public endpoint

Protocol endpoints (OID4VCI, OID4VP, ISO 18013-7, `.well-known`, public status and trust lists) must not carry the `/api` prefix. Add the route to `GLOBAL_PREFIX_EXCLUSIONS` in `main.helpers.ts` (covered by `main.helpers.spec.ts`). Map application errors to the protocol's error format in the controller (for example `OAuthError` for OAuth endpoints).

### A database migration

1. Change the entity, then create the migration from `apps/backend` with `pnpm migration:create src/database/migrations/<Name>` (commands: [Development setup](./development-setup.md#database-migrations)).
2. Make it work on SQLite and PostgreSQL and idempotent: check with `queryRunner.getTable()` / `findColumnByName()` before changing a table, as the existing migrations do. Implement `down()` where possible.
3. Export the class from `src/database/migrations/index.ts`; migrations are loaded from that index, not by file glob.
4. Cover data changes with a spec (see `src/database/*-migration.spec.ts`) and run `test/migrations.e2e-spec.ts`.

A pure source move of an entity needs no migration. Migrations run on startup, so a schema change in a release reaches every installation automatically.

### An environment variable

1. Add the key to the Joi schema of the owning capability (`<feature>-validation.schema.ts`) with a default, `.description(…)` and `.meta({ group, order })`. A new schema file is added to `platform/config/combined.schema.ts`.
2. Read the value once into typed settings in the module; do not inject `ConfigService` into core code.
3. The [environment variable reference](../reference/environment-variables.md) is generated from this schema at docs build time (`<ConfigTable group="…" />`); a new group needs a section there.
4. If the variable is required, add a placeholder to `.env.example`; CI runs `pnpm check:env-example`.
5. A switch that turns off a check of the normal flow is named `SKIP_<CHECK>`, defaults to `false` and goes into `platform/config/skip-validation.schema.ts`, so it is logged on startup.

### An adapter or format

| Extension | Contract | Registration |
| --- | --- | --- |
| Credential format (issuance) | `CredentialIssuerFormat` (`issuer/configuration/credentials/domain/`) | `CredentialIssuerFormatRegistry` in `credential-issuance.module.ts` |
| Credential format (verification) | `CredentialVerifierFormat` (`verifier/presentations/domain/`) | `credential-verifier-format-registry.ts`; OID4VP and ISO 18013-7 resolve formats from it |
| File storage | `FileStorage` in `storage/storage.types.ts` | `FILE_STORAGE` factory in `StorageModule.forRoot()`, selected by `STORAGE_DRIVER`; add the value to `storage-validation.schema.ts` |
| KMS provider | `KmsAdapter` (`crypto/key/kms/kms-adapter.ts`) | `kms-provider.registry.ts` and the provider schema in `crypto/key/schemas/kms-config.schema.ts` |
| Claims source | `CredentialClaimsProvider` (`issuer/configuration/credentials/domain/credential-claims.ts`) | `ConfiguredCredentialClaimsProvider` in `application/`, with the webhook adapters |

OpenID Federation is split the same way: the `FederationResolver` port (`trust/ports/`) with the `OpenIdFederationResolver` HTTP adapter, the `EvaluateFederationTrustChain` use case (`trust/application/`) and `FederationTrustService` for trust modes, caching and metrics.

## Current boundary enforcement

`apps/backend/src/platform/module-boundaries.spec.ts` and `apps/backend/test/architecture/dependency-rules.spec.ts` run with `pnpm --filter @eudiplo/backend test`. They use the TypeScript compiler API, so no extra lint tool is involved.

- Files in feature-local `application/`, `domain/` and `ports/` folders are migrated core code and are checked automatically (tests excluded). `adapters/`, `infrastructure/` and `entities/` are infrastructure; `*.controller.ts` and `*.module.ts` are inbound adapters and composition roots.
- Core checks follow the transitive local import graph, including type-only imports, re-exports, dynamic imports and path aliases. Computed imports in core code are rejected.
- Application code may import only `Inject`, `Injectable` and `Optional` from `@nestjs/common`; domain and port code may not depend on NestJS. The forbidden packages are `forbiddenPackages` in `test/architecture/dependency-rules.ts`. Add newly encountered infrastructure SDKs there with a fixture test.
- Domain code must not depend on application code; ports may use domain models but not application classes.
- Controllers may not depend on TypeORM or on repositories (`*.repository.ts`), also through barrel exports.
- `shared/` must not import features, and removed catch-all directories cannot come back.

### Ratchet baseline

`apps/backend/test/architecture/architecture-baseline.json` lists existing debt per file and category, so it can only shrink. The test fails when a file gains a category that is not in the baseline, and when the baseline lists a category the file no longer has. After removing debt, regenerate and commit it with the change:

```bash
UPDATE_ARCHITECTURE_BASELINE=1 pnpm --filter @eudiplo/backend test
```

Do not regenerate to accept new debt; move the dependency behind a port or into the controller or module instead. Legacy files are only checked for the ratchet categories, and the checks cannot prove runtime wiring, so keep adapter contract tests, DI wiring tests and HTTP E2E tests next to them.

## Before you open a pull request

```bash
pnpm --filter @eudiplo/backend run format:check
pnpm --filter @eudiplo/backend run lint
pnpm --filter @eudiplo/backend run build
pnpm --filter @eudiplo/backend run test
```

Run the affected E2E suites when module wiring, persistence or a protocol flow changes ([Testing](./testing.md#e2e-testing)), and update the documentation page that owns the behavior.
