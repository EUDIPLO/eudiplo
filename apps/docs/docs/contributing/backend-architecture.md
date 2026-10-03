---
title: Backend Architecture
---

## Backend Architecture

### Status

Target architecture for the EUDIPLO backend. The migration is incremental: see the [refactoring plan](https://github.com/openwallet-foundation/eudiplo/blob/main/apps/backend/docs/refactoring-plan.md) for what is done, the known debt, and the next slices. The plan is not an instruction to execute tasks automatically.

Apply these boundaries to new or explicitly migrated application/domain code. Existing services mix responsibilities; classify a component by its role rather than its `*.service.ts` suffix. Preserve the capability ownership and module rules in [Backend Development](#backend-development).

Internal changes are permitted within the requested task, with all affected callers updated. Preserve public HTTP/protocol contracts, SDK/configuration formats, persisted data, and security behavior unless a behavior change is explicitly in scope. Architectural preference alone does not authorize an external breaking change.

### Scope: where the layering applies

Ports and adapters are a tool, not a goal. Apply them where they pay off, and keep everything else simple.

| Area | Expected shape | Why |
| --- | --- | --- |
| Protocol and trust core: OID4VCI, OID4VP, authorization, credential formats, trust evaluation, sessions | Use cases in `application/`, rules in `domain/`, infrastructure behind `ports/` | Security-critical branching logic that must be testable without HTTP or a database; real extension points (formats, claims providers, trust sources, KMS, storage). |
| Administrative CRUD: tenant, client, credential/issuance/presentation configuration, status-list configuration, registrar configuration, audit log, config import/export | A feature service with an injected TypeORM repository is fine | Read, validate and save have little logic. Extra layers add ceremony without making the code safer or easier to change. |

Rules for the CRUD shape: keep DTO validation in the controller, keep tenant scoping on every query, throw `NotFoundError` subclasses or Nest HTTP exceptions, and do not put protocol logic there. When a CRUD service starts to carry real business rules, or becomes a dependency of the protocol core, extract a port for what the core needs.

The migration is **done** when the protocol and trust core follows the target shape and the ratchet baseline contains no core-related legacy entries. Administrative CRUD does not need to be migrated.

### Architectural style

EUDIPLO is a modular monolith using pragmatic hexagonal / ports-and-adapters principles.

The architecture is capability-oriented rather than layer-folder-oriented.

Top-level capabilities may include:

```text
issuer/
verifier/
session/
trust/
crypto/
registrar/
auth/
storage/
platform/
```

The important architectural property is dependency direction, not uniform folder naming.

### Dependency direction

```text
Inbound adapter → Application / use case → Domain
                          ↓
                    Outbound port
                          ↑
                 Infrastructure adapter
```

Arrows describe source dependencies, not runtime call order. The application owns outbound ports and may depend on domain types; adapters depend inward on those contracts. Domain rules remain independent of application orchestration, transport, persistence, and adapter implementations.

NestJS modules wire implementations to tokens. Minimal NestJS DI decorators may remain on application classes when direct construction with fake dependencies still works; domain code stays framework-independent. HTTP exceptions, lifecycle hooks, scheduling, and framework configuration belong outside the application core.

### Vocabulary and placement

| Role | Responsibility and placement |
| --- | --- |
| Controller / inbound adapter | Parse transport input, invoke a use case, map results and errors; feature controller or protocol adapter. |
| Application service / use case | Coordinate one workflow through domain rules and ports; inside the owning capability. |
| Domain service / model | Express infrastructure-independent rules and state; inside the owning capability. |
| Port | Application-owned contract for a required capability; near its consumers, not in a global catch-all folder. |
| Adapter | Implement a port with persistence, transport, or an SDK; owned by the relevant capability. |
| Repository | Port exposing aggregate operations with explicit tenant scope and atomicity requirements. |
| Persistence entity | TypeORM-decorated database representation; confined to persistence and composition. |
| DTO | Inbound/outbound API shape with validation/Swagger metadata; map to application commands/results at the boundary. |

Use local `application/`, `domain/`, `ports/`, or `adapters/` folders when they clarify an extracted boundary. Small features do not need empty layers or one class per method. Cross-capability consumers use explicit public contracts; avoid deep imports into another capability's implementation.

#### Feature folder shape

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

- **Errors.** Application and domain code throw plain `Error` subclasses. A missing resource extends `NotFoundError` from `shared/domain/not-found-error.ts`, which `AllExceptionsFilter` maps to 404. Any other application error is mapped explicitly by the controller or protocol service that calls the use case.
- **Wiring.** A framework-free class with constructor dependencies must be registered with a `useFactory` provider that lists its `inject` tokens. As a bare class provider without `@Injectable()`, Nest constructs it with `undefined` dependencies.
- **Request data.** Services receive plain values, never the Express `Request`. For audit metadata, controllers use the `@AuditMeta()` parameter decorator and pass an `AuditLogRequestMeta`.
- **Single use is a conditional update.** Codes, nonces, `request_uri`s and presentation responses are consumed with one conditional write (for example `SessionStore.updateIfUnconsumed` or `consumeRequestUri`) whose result decides who wins. Never read a flag and write it later: concurrent requests would both pass.
- **Adapters are not a parking place.** `adapters/` is only checked for HTTP exceptions and imports of controllers, modules and other capabilities' adapters, so it must only hold code that implements a port. Moving orchestration there hides it from the checks.

#### Reference implementations

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

### Inbound adapters

Examples:

- REST controllers
- OID4VCI protocol endpoints
- OID4VP protocol endpoints
- administrative APIs
- future CLI/application entry points

Inbound adapters translate transport/protocol input into application commands and map application results/errors back to the transport/protocol.

### Application layer

The application layer coordinates use cases.

Examples:

- creating credential offers
- processing credential requests
- issuing credentials
- handling deferred issuance
- processing credential notifications
- creating presentation requests
- validating presentation responses
- resolving credential claims
- evaluating trust

Application code should express business/protocol workflow, not infrastructure mechanics.

### Domain logic

Domain logic contains rules and behaviour that do not require infrastructure.

Examples may include:

- state transitions
- credential-format-independent validation
- trust-policy decisions
- issuance policy decisions
- presentation policy decisions

Not every feature needs a separate rich domain model.

### Outbound ports

Ports represent application dependencies on external capabilities.

Examples:

```text
SessionRepository
CredentialClaimsProvider
CredentialNotificationPublisher
PresentationResultPublisher
FederationResolver
TrustListProvider
CredentialIssuerFormat
CredentialVerifierFormat
FileStorage
KmsAdapter
ClientsProvider
```

Ports should be domain-specific.

Avoid generic abstractions that simply mirror an infrastructure library.

### Infrastructure adapters

Adapters implement ports using concrete technologies.

Examples:

```text
SessionRepository
  └─ TypeOrmSessionRepository

FileStorage
  ├─ LocalFileStorage
  └─ S3FileStorage

KmsAdapter
  ├─ DbKmsAdapter
  ├─ VaultKmsAdapter
  ├─ AwsKmsAdapter
  ├─ CscKmsAdapter
  ├─ HttpKmsAdapter
  └─ Pkcs11KmsAdapter

CredentialClaimsProvider
  └─ ConfiguredCredentialClaimsProvider
       ├─ WebhookRemoteCredentialClaims
       └─ WebhookSessionCredentialClaims

FederationResolver
  └─ OpenIdFederationResolver
```

### NestJS responsibility

NestJS remains the application framework and dependency injection container.

Nest modules should primarily act as composition roots.

Example:

```ts
{
    provide: SESSION_REPOSITORY,
    useClass: TypeOrmSessionRepository,
}
```

Application logic should not instantiate adapters directly.

### Persistence

TypeORM is an infrastructure detail.

Application-facing services and ports should not expose TypeORM-specific types.

Avoid exposing:

- `Repository<T>`
- `FindOptionsWhere`
- `DeepPartial`
- `QueryDeepPartialEntity`

Use application-specific models and repository operations.

### Credential formats

Credential formats are a first-class extensibility boundary.

OID4VCI is a transport/orchestration protocol and must not own SD-JWT VC or mdoc implementation details.

OID4VP is likewise responsible for presentation orchestration rather than format-specific cryptographic verification.

Preferred architecture:

```text
                     Issuance
                        │
                CredentialIssuerFormat
                  ┌─────┴─────┐
                  │           │
              SD-JWT VC     mdoc

                   Verification
                        │
               CredentialVerifierFormat
                  ┌─────┴─────┐
                  │           │
              SD-JWT VC     mdoc
```

Separate issuer and verifier interfaces are preferred if their responsibilities differ significantly.

#### Format-specific concerns

Keep format-specific behaviour inside the implementation where practical.

SD-JWT VC examples:

- disclosures
- disclosure frame
- `vct`
- JOSE handling
- SD-JWT-specific key binding

mdoc examples:

- document type
- namespaces
- issuer-signed items
- DeviceKeyInfo
- COSE algorithms
- mdoc-specific holder binding

#### Registry

Use a format registry to resolve a suitable format implementation.

Avoid format-specific `switch` or `if` statements distributed throughout OID4VCI and OID4VP.

### Claim resolution

Credential claims should be resolved through an application abstraction such as:

```ts
interface CredentialClaimsProvider {
    resolveClaims(
        request: CredentialClaimsRequest,
    ): Promise<CredentialClaimsResult>;
}
```

HTTP webhooks are one adapter (`ConfiguredCredentialClaimsProvider` with a webhook remote-claims adapter). It builds on the existing attribute-provider configuration and preserves configured claims, deferred results, validation, authentication, and outbound URL policy.

This allows future implementations such as:

- static/configured claims
- database-backed providers
- n8n/workflow integrations
- custom provider plugins

### Trust architecture

Separate:

- trust policy/evaluation
- federation resolution
- trust-list retrieval
- X.509 validation
- network transport
- caching

Trust decisions should be testable without HTTP.

### Errors

Application/domain code should use application/domain errors.

Examples:

```text
SessionNotFound
CredentialConfigurationNotFound
UnsupportedCredentialFormat
InvalidCredentialProof
CredentialVerificationFailedError
IncompletePresentationError
```

Inbound adapters translate these into protocol/transport errors. Not-found errors extend the shared `NotFoundError` base and are mapped to 404 centrally; see [Feature folder shape](#feature-folder-shape).

### Configuration

Configuration should be validated centrally and passed into application components as typed capability-specific settings.

Avoid injecting `ConfigService` throughout core application logic.

### Testing strategy

Preferred layers:

```text
E2E / conformance tests
          ↓
integration tests
          ↓
application/use-case tests
          ↓
domain unit tests
```

Application tests should use fake ports.

Adapters with multiple implementations should share contract test suites for their common guarantees, with capability-specific cases where implementations differ. SD-JWT VC and mdoc must retain their distinct binding and disclosure semantics.

Add characterization and boundary tests with each migrated slice. Preserve tenant isolation, atomic offer consumption, replay/nonce/DPoP checks, cleanup of sensitive data, and SQLite/PostgreSQL semantics. Introduce application models, error mapping, typed settings, and DI wiring alongside the use case that needs them rather than postponing those dependencies.

Unit tests belong beside source as `*.spec.ts`; E2E tests use `apps/backend/test/*.e2e-spec.ts`. `apps/backend/src/platform/module-boundaries.spec.ts` enforces shared-code isolation, legacy directory placement, layer boundaries and the ratchet baseline. Its helpers and fixture tests live in `apps/backend/test/architecture/`.

### Current boundary enforcement

The checks use the installed TypeScript compiler API and Vitest, without introducing another lint/dependency tool. The existing CI unit-test job executes them.

- Feature-local `application/`, `domain/`, and `ports/` directories identify migrated core code. Every production TypeScript file in those directories is checked automatically; tests are excluded.
- `adapters/`, `infrastructure/`, and `entities/` identify infrastructure. `*.controller.ts` and `*.module.ts` identify inbound adapters and composition roots.
- Core checks follow the transitive local import graph, including type-only imports, re-exports, dynamic imports, and TypeScript-resolved aliases / `.js` specifiers. Unclassified helpers do not hide infrastructure dependencies from a migrated consumer. Computed imports in core code are rejected because the target cannot be checked.
- Application code may import only `Inject`, `Injectable`, and `Optional` from `@nestjs/common`; domain and port code may not depend on NestJS. Core code may not depend on the forbidden persistence, HTTP, filesystem, cloud, or identity-provider packages listed in the checker, or on local adapters/controllers/modules.
- Domain code must not depend on application orchestration or application ports. Ports may use domain models but not application implementation classes.
- Core code may not import validation, DTO or logging frameworks (`class-validator`, `class-transformer`, `nestjs-zod`, `nestjs-pino`). Plain zod schemas are allowed in `domain/`; DTOs wrap them with `createZodDto`.
- Controllers are checked for direct TypeORM dependencies and repository contracts/adapters named `*.repository.ts`, including forwarded barrel exports. They should invoke application behavior instead.

#### Ratchet baseline

`apps/backend/test/architecture/architecture-baseline.json` lists existing debt per file and category, so it can only shrink:

- Legacy files (no role above; migrations and generated code excluded): `express` everywhere. In the protocol core (`issuer/issuance/`, `verifier/`, `trust/`, `session/`) also `config` (`@nestjs/config`), `typeorm` (`typeorm`, `@nestjs/typeorm`) and `http-exception` (Nest `…Exception` from `@nestjs/common`). Administrative CRUD outside these paths, and presentation configuration management in `verifier/presentations/configuration/`, may use them freely, see [Scope](#scope-where-the-layering-applies).
- Adapters: `http-exception`, `adapter->controller`, `adapter->module`, `adapter->other-capability-adapter` (a capability is the first folder under `src/`).
- Controllers: `controller->adapter`.

The test fails when a file gains a category that is not in the baseline, and when the baseline lists a category the file no longer has. After removing debt, regenerate the file and commit it with the change:

```bash
UPDATE_ARCHITECTURE_BASELINE=1 pnpm --filter @eudiplo/backend test
```

Do not regenerate to accept new debt; move the dependency behind a port or into the controller/module instead.

#### What the checks do not cover

Legacy files are only checked for the ratchet categories above, so they can still mix orchestration with persistence; the [refactoring plan](https://github.com/openwallet-foundation/eudiplo/blob/main/apps/backend/docs/refactoring-plan.md#known-debt) lists the hotspots. The boundary checks also cannot prove runtime wiring or behavior, so keep adapter contract tests, DI wiring tests, and HTTP integration tests alongside them.

Use the enforced directories for newly extracted core code. Add any newly encountered infrastructure SDK to the package rules and test it with a fixture.

### Architectural principle

The objective is not maximum abstraction.

The objective is that EUDIPLO's protocol orchestration and application behaviour remain stable when infrastructure changes, including:

- database
- HTTP framework
- KMS
- storage
- trust infrastructure
- credential format
- identity provider
- claims provider

## Backend Development

The backend uses NestJS modules grouped by business capability. The structure is deliberately pragmatic: code that changes together stays together, while cross-cutting infrastructure has an explicit home.

### Target Architecture and Refactoring

The [target backend architecture](backend-architecture.md) defines the intended application, domain, port, and adapter boundaries. Existing code is being migrated incrementally; the [refactoring plan](https://github.com/openwallet-foundation/eudiplo/blob/main/apps/backend/docs/refactoring-plan.md) tracks what is done and what comes next. It is not an instruction to execute tasks automatically.

Follow the placement rules below and apply the target boundaries within each selected slice. Include the necessary models, error mapping, composition, and tests with that slice.

### Directory Map

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

### Placement Rules

Use the narrowest owner that describes the code:

1. Put protocol and business behavior in its feature directory. For example, status-list behavior belongs in `issuer/status-list/`, not in `shared/`.
2. Put application-wide technical capabilities in `platform/`. Configuration loading, data-at-rest encryption, and logging setup are platform concerns.
3. Put code in `shared/` only when it is feature-independent, stateless or narrowly scoped, and safe to import from any feature. `shared/` must not import from application features.
4. Give every injectable provider one owning module. Other features import that module and use its exports instead of registering the provider again.
5. Keep controllers, DTOs, entities, validation schemas, and services close to their feature. Split a module when its providers form a distinct capability with a clear public API.

### Module Dependencies

`AppModule` is the composition root. It initializes global framework modules and imports the top-level application modules.

Within the application:

- import another NestJS module when using its exported providers;
- do not copy a foreign provider into a module's `providers` array;
- avoid `forwardRef()` unless two modules have a real runtime cycle that cannot first be removed by changing ownership or extracting a smaller service;
- keep feature imports out of `shared/`;
- export only the providers or submodules that consumers actually require.

The boundary test in `apps/backend/src/platform/module-boundaries.spec.ts` protects the `shared/` dependency rule, prevents old catch-all directories from returning, and enforces migrated application/domain/port boundaries. See [current enforcement and legacy exceptions](#current-boundary-enforcement) before extracting a new use case.

### Feature Module Shape

See [Feature folder shape](#feature-folder-shape) for the folder layout, error mapping, and wiring rules. A feature does not need every folder: small, feature-specific helpers can stay next to the code that uses them. Extract a use case or service when the behavior has its own dependencies, lifecycle, or focused tests.

### Adding or Moving Backend Code

Before opening a pull request:

- identify the feature or platform capability that owns the behavior;
- import the owning module rather than re-registering its provider;
- add focused unit tests beside extracted services;
- update imports, E2E utilities, generation scripts, and documentation paths;
- run the backend format check, build, lint, and unit tests;
- run relevant E2E tests when module wiring or protocol behavior changes (see [Running E2E tests locally](./testing.md#running-e2e-tests-locally)).

From the repository root, the main backend checks are:

```bash
pnpm --filter @eudiplo/backend run format:check
pnpm --filter @eudiplo/backend run build
pnpm --filter @eudiplo/backend run lint
pnpm --filter @eudiplo/backend run test
```

When moving TypeORM entities, confirm that migration discovery and any data source imports still resolve. A source-code move alone should not create a database migration unless the persisted schema also changes.

### Related Documentation

- [Development Setup](./development-setup.md) — Environment configuration and running locally
- [Repository Structure](./development-setup.md#workspace-structure) — Monorepo layout and workspace conventions
- [Testing](./testing.md) — Writing and running unit tests
- [E2E Testing](./testing.md#e2e-testing) — Integration and end-to-end test workflows
