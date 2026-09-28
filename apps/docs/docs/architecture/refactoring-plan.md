# Backend Refactoring Plan

## Status

The backend is migrating incrementally toward the [target architecture](./backend-architecture.md). Work happens in bounded vertical slices; per-slice details live in commit messages and pull requests, not in this document.

- **Last reviewed:** 2026-09-28, full review of the migration on branch `fix/refactor-backend`.
- **Enforced by:** `apps/backend/test/architecture/dependency-rules.spec.ts` and `apps/backend/src/platform/module-boundaries.spec.ts`. Both run with `pnpm --filter @eudiplo/backend test`. See [boundary enforcement](./backend-architecture.md#current-boundary-enforcement).

This plan is not an instruction to execute tasks automatically. Pick one slice, agree on its scope, and complete it end to end.

## Task status

| Task | Topic | Status | Remaining work |
| --- | --- | --- | --- |
| 1 | Target architecture documented | Done | Keep [backend-architecture.md](./backend-architecture.md) as the single placement reference. |
| 2 | Boundary enforcement | Done | Layer checks plus a ratchet baseline for legacy debt. Remaining gap E5 under [enforcement gaps](#enforcement-gaps). |
| 3–4 | Session repository and lifecycle | Done | Other features use `SessionStore` and session use cases; the repository port stays inside `SessionModule`. |
| 5–6 | OID4VCI use cases, no Express | Partial | Issuer metadata, authorization-server selection and deferred issuance use ports. `Oid4vciService` still parses requests and maps protocol errors with Nest exceptions; authorization services still orchestrate in legacy services. |
| 7–9 | Issuer credential formats | Done | Registry dispatches to SD-JWT VC and mdoc issuers typed on the plain `CredentialConfiguration` model. |
| 10–11 | Claims provider and publisher ports | Done | Unify claim-source selection between `IssueCredential` and `ConfiguredCredentialClaimsProvider`. |
| 12–13 | Trust retrieval and federation resolver | Partial | Federation trust is not cryptographically anchored (T1), traversal needs limits (T2). |
| 14 | OID4VP use cases | Partial | Request retrieval, response parsing and completion extracted. `PresentationsService` (~710 lines, was 2320) now only verifies the `vp_token`; configuration CRUD, registration certificates, metadata import and trusted authorities are separate services, DCQL claim rules are pure domain functions. Verification orchestration is not yet a use case. |
| 15–16 | Verifier credential formats | Partial | Registry exists but formats have different `verify` signatures; mdoc transcript and SD-JWT key-binding values are still built in `PresentationsService`; ISO 18013 bypasses the registry. |
| 17–18 | Configuration repositories, plain models | Done for tenant, credential, issuance, attribute-provider, webhook-endpoint | Status-list, registrar, key-chain and config-portability still use TypeORM in services. Presentation configuration is administrative CRUD: `verifier/presentations/configuration/` keeps TypeORM in plain services and is excluded from the protocol-core ratchet. Credential configurations use one `CredentialConfigurationRepository` port owned by `CredentialConfigModule`. |
| 19 | Client provider abstraction | Done in code | Regenerate the SDK (C7) and validate Keycloak mode against a live instance. |
| 20 | Typed settings instead of `ConfigService` | Partial | Protocol-core files still importing `@nestjs/config` are listed in the ratchet baseline. Administrative CRUD may keep `ConfigService`. |
| 21 | Modules as composition roots | Partial | Applied to migrated slices. |
| 22 | Application errors instead of HTTP exceptions | Partial | Applied to migrated slices; legacy services still throw Nest exceptions. |
| 23 | Adapter contract tests | Partial | Session and configuration repositories covered on SQLite and PostgreSQL. Storage, KMS, client providers and credential formats open. |
| 24 | Pure application tests | Partial | Present for every extracted use case. |
| 25 | Final dependency audit | Done | The ratchet baseline `apps/backend/test/architecture/architecture-baseline.json` is the audit. The migration is done when it has no protocol-core entries. |

## Known debt

These legacy services still mix orchestration with persistence, configuration, transport or HTTP errors:

| Area | Files | Notes |
| --- | --- | --- |
| Verification | `verifier/presentations/presentations.service.ts`, `verifier/oid4vp/oid4vp.service.ts`, `verifier/iso18013/iso18013.service.ts` | `PresentationsService.parseResponse` still orchestrates verification with Nest exceptions; OID4VP and ISO 18013 build `VerifierOptions` separately. Remaining steps under [next slices](#next-slices). |
| OID4VCI | `issuer/issuance/oid4vci/oid4vci.service.ts` (~670 lines) | Credential request parsing, decryption and protocol error mapping in one service; throws Nest exceptions. |
| Authorization | `issuer/issuance/oid4vci/authorization/**` | `authorize.service.ts`, `interactive-authorization.service.ts`, `chained-as.service.ts`, `authorization-servers.service.ts`. |
| Other capabilities | `issuer/status-list/`, `crypto/key/`, `registrar/`, `platform/config-portability/`, `audit-log/`, `storage/files.service.ts` | Not yet in scope of any slice. |

The ratchet baseline (`apps/backend/test/architecture/architecture-baseline.json`) tracks the size of the remaining core work: at the time of writing 35 files, with 6 protocol-core files importing `@nestjs/config`, 9 TypeORM, 27 files using Nest HTTP exceptions (protocol core and adapters), and 6 files importing Express.

## Open review findings

Findings from the 2026-09-28 review that are not fixed yet. Items marked *pre-existing* also exist on `main`.

### Security and behavior

- **T1 — Federation trust is not anchored** (*pre-existing*). The entity ID is taken from the credential's own certificate, and nothing binds the credential key to that entity's federation keys. The new `x5c` signature check verifies an entity configuration only against its own embedded certificate, and unsigned JSON or JWT responses are still accepted. Either implement OpenID Federation chain validation (entity self-signature against `jwks`, subordinate statements, configured anchor keys; reject unsigned responses) or document federation-only trust as unauthenticated.
- **T2 — Federation fetches bypass the outbound URL policy.** Traversal is now bounded (10 hints per entity, 32 resolutions per evaluation, 5 s timeout), but federation fetches do not apply `OutboundUrlPolicyService`, and TLS verification is disabled outside `NODE_ENV=production` in `TrustModule`. Applying the policy needs a decision because it resolves hosts via DNS (the E2E fixtures use mocked hosts).
- **V2 — Verifier terminal states bypass `ChangeSessionState`** (*pre-existing*). OID4VP and ISO 18013 set `Completed`/`Failed` through generic updates, so no SSE event or metric is emitted. `SessionUpdate` should not accept `status`.
- **I3 — Deferred retrieval is not bound to the issuing session** (*pre-existing*). Any valid access token of the tenant whose `authorization_details` allow the configuration can poll any `transaction_id`; the random UUID is the only protection. Store the token identity (issuer and subject, or a session reference resolved like the credential endpoint does) on the transaction and compare it on retrieval. Needs a schema migration.
- **I2 — Explicit authorization-server selection stores a URL** (*pre-existing*). When an offer names `authorization_server`, the session's `authorizationServerId` receives the resolved issuer URL instead of the configured id (`SelectAuthorizationServer`). Decide which value consumers expect.

### Cleanup

- **O4** `IssuanceService.reissueRegistrationCertificate` duplicates the registration-certificate material, fingerprint and JWT-window helpers; reuse `oid4vci/domain/issuer-registration-certificate.ts`.

### Enforcement gaps

- **E5** Rewrite the `shared/` isolation check on the TypeScript import graph so aliases, re-exports and dynamic imports are covered.

## Next slices

Take them in this order unless a finding above is more urgent.

1. **Security findings T2, I1, V1.** Each is small and has a clear test.
2. **Enforcement E5**, so the `shared/` isolation check covers aliases and re-exports.
3. **Verifier decomposition.** Done: presentation configuration CRUD, registration certificates and metadata import (`verifier/presentations/configuration/`), `TrustedAuthoritiesService`, and the DCQL claim policy (`verifier/presentations/domain/dcql-claim-policy.ts`). Remaining:
   1. One `CredentialVerifierFormat.verify(credential, context)` signature with a common result, with mdoc transcript and SD-JWT key binding inside the adapters; ISO 18013 uses the registry.
   2. `VerifyPresentationResponse` use case in `verifier/presentations/application/` replacing `parseResponse`, with application errors that `Oid4vpService` maps to today's responses and session log error names (`presentations.service.spec.ts` characterizes them).
   3. `Oid4vpService` shrinks to request creation and HTTP mapping.
4. **Authorization services**: token, PAR and pre-authorized flows as use cases with OAuth-specific application errors and typed settings.
5. **Contract tests (Task 23)** for storage, KMS and client providers.
6. **T1** once the federation trust model is decided.

## Requirements for every slice

- Characterize observable success and failure behavior before extraction, including HTTP/protocol error bodies, status codes and headers.
- Preserve public APIs, SDK/configuration formats, persisted data, tenant isolation and security checks unless a change is explicitly in scope.
- Include the models, typed settings, module wiring, application errors and tests the slice needs; do not postpone them.
- Define transaction boundaries, atomic updates, concurrency outcomes and event timing before replacing persistence. Preserve SQLite and PostgreSQL behavior; source moves alone should not create migrations.
- Map every new application error at the boundary, and add a DI wiring test for framework-free classes registered with factories.
- Validate with unit and boundary tests, backend build, lint, format check, and the affected E2E suites. Database adapters need real SQLite and PostgreSQL coverage.
- Update the task table and findings in this document in the same pull request.

## Task reference

Short goals and acceptance criteria for the original task list.

| Task | Goal | Accepted when |
| --- | --- | --- |
| 1 | Document the target architecture | Contributors can tell where new code belongs. |
| 2 | Enforce boundaries in CI | New violations fail CI; exceptions are listed as data. |
| 3 | `SessionRepository` port | Session application code has no TypeORM imports; contract tests on SQLite and PostgreSQL. |
| 4 | Split `SessionService` | Persistence, scheduling, metrics, events and lifecycle rules are separate. |
| 5 | Decompose `Oid4vciService` | Use cases are independently testable; the service is a small facade or gone. |
| 6 | No Express in OID4VCI application code | Controllers adapt HTTP input to plain commands and context. |
| 7–8 | Issuer format abstraction and registry | Adding a format means adding and registering an adapter. |
| 9 | Credential creation independent of OID4VCI | Credentials can be generated without an OID4VCI request. |
| 10 | `CredentialClaimsProvider` | Claim resolution does not expose webhook concepts. |
| 11 | Business-specific publisher ports | Application code expresses business intent, not HTTP intent. |
| 12 | Separate trust evaluation from retrieval | Trust policy tests run without HTTP. |
| 13 | `FederationResolver` port | Trust evaluation performs no federation HTTP directly. |
| 14 | OID4VP use cases | Verification flows are testable without HTTP or TypeORM. |
| 15–16 | Verifier format abstraction, aligned with issuer | Adding a presentation format does not change OID4VP orchestration. |
| 17 | Repository ports for configuration aggregates | Migrated services do not depend on TypeORM. |
| 18 | Plain models instead of entities | Schema changes do not force port changes. |
| 19 | Client provider without entity leakage | Keycloak and TypeORM details stay inside adapters. |
| 20 | Typed capability settings | Important application services do not inject `ConfigService`. |
| 21 | Modules as composition roots | Application code never selects infrastructure. |
| 22 | Application errors | Application/domain code has no Nest HTTP exceptions. |
| 23 | Adapter contract tests | Interchangeable adapters share a contract suite. |
| 24 | Pure application tests | Branching business logic is covered without Nest or a database. |
| 25 | Final dependency audit | No unexplained dependency-direction violations remain. |
