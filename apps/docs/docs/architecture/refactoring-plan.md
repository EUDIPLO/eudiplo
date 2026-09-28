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
| 5–6 | OID4VCI use cases, no Express | Partial | Issuer metadata, authorization-server selection and deferred issuance use ports. The built-in authorization server's token, PAR and authorization endpoints are use cases in `oid4vci/authorization/application/` with transport-neutral `OAuthError`s mapped by `AuthorizeController`. `Oid4vciService` still parses requests and maps protocol errors with Nest exceptions; the interactive, chained and OID4VP-backed authorization servers still orchestrate in legacy services. |
| 7–9 | Issuer credential formats | Done | Registry dispatches to SD-JWT VC and mdoc issuers typed on the plain `CredentialConfiguration` model. |
| 10–11 | Claims provider and publisher ports | Done | Unify claim-source selection between `IssueCredential` and `ConfiguredCredentialClaimsProvider`. |
| 12–13 | Trust retrieval and federation resolver | Partial | Federation trust is not cryptographically anchored (T1), traversal needs limits (T2). |
| 14 | OID4VP use cases | Partial | Request retrieval, response parsing, `vp_token` verification (`VerifyPresentationResponse`) and completion are use cases; `PresentationsService` is gone. `Oid4vpService` (~920 lines) still creates requests, decrypts responses and maps application errors to HTTP exceptions. |
| 15–16 | Verifier credential formats | Done | One `CredentialVerifierFormat.verify(credential, context)` contract (`presentations/domain/`) with adapters in `presentations/adapters/`: mdoc builds its session transcript, SD-JWT VC its key-binding nonce and audience. OID4VP and ISO 18013 both resolve formats from the registry. Format-specific DCQL claim semantics (mdoc verifies each `claim_sets` option, SD-JWT VC matches once) live in the adapters. |
| 17–18 | Configuration repositories, plain models | Done for tenant, credential, issuance, attribute-provider, webhook-endpoint | Status-list, registrar, key-chain and config-portability still use TypeORM in services. Presentation configuration is administrative CRUD: `verifier/presentations/configuration/` keeps TypeORM in plain services and is excluded from the protocol-core ratchet. Credential configurations use one `CredentialConfigurationRepository` port owned by `CredentialConfigModule`. |
| 19 | Client provider abstraction | Done in code | Regenerate the SDK (C7) and validate Keycloak mode against a live instance. |
| 20 | Typed settings instead of `ConfigService` | Partial | Only `verifier/iso18013/iso18013.service.ts` still imports `@nestjs/config` in the protocol core. Administrative CRUD may keep `ConfigService`. |
| 21 | Modules as composition roots | Partial | Applied to migrated slices. |
| 22 | Application errors instead of HTTP exceptions | Partial | Applied to migrated slices; legacy services still throw Nest exceptions. |
| 23 | Adapter contract tests | Partial | Session and configuration repositories covered on SQLite and PostgreSQL. Storage, KMS, client providers and credential formats open. |
| 24 | Pure application tests | Partial | Present for every extracted use case. |
| 25 | Final dependency audit | Done | The ratchet baseline `apps/backend/test/architecture/architecture-baseline.json` is the audit. The migration is done when it has no protocol-core entries. |

## Known debt

These legacy services still mix orchestration with persistence, configuration, transport or HTTP errors:

| Area | Files | Notes |
| --- | --- | --- |
| Verification | `verifier/oid4vp/oid4vp.service.ts`, `verifier/iso18013/iso18013.service.ts` | Request creation, JWE decryption and HTTP error mapping in `Oid4vpService`; `Iso18013Service` orchestrates offer, decryption, verification and session updates with `ConfigService`, TypeORM and Nest exceptions. The format verifiers under `presentations/credential/` still throw `SdJwtVerificationError` (a `BadRequestException`). |
| OID4VCI | `issuer/issuance/oid4vci/oid4vci.service.ts` (~670 lines) | Credential request parsing, decryption and protocol error mapping in one service; throws Nest exceptions. |
| Authorization | `issuer/issuance/oid4vci/authorization/**` | Settings and persistence go through `OID4VCI_SETTINGS` and the `ChainedAsSessionRepository` / `InteractiveAuthSessionRepository` ports. `interactive-authorization.service.ts` (~960 lines), `chained-as.service.ts` (~900), `authorization-servers.service.ts` and `chained-as-vp.service.ts` still orchestrate and throw Nest exceptions; the three chained variants duplicate PAR, authorize and token handling (`shared/chained-as-token.util.ts`). |
| Other capabilities | `issuer/status-list/`, `crypto/key/`, `registrar/`, `platform/config-portability/`, `audit-log/`, `storage/files.service.ts` | Not yet in scope of any slice. |

The ratchet baseline (`apps/backend/test/architecture/architecture-baseline.json`) tracks the size of the remaining core work: at the time of writing 33 files, with 1 protocol-core file(s) importing `@nestjs/config`, 4 TypeORM, 25 files using Nest HTTP exceptions (protocol core and adapters), and 6 files importing Express.

## Open review findings

Findings from the 2026-09-28 review that are not fixed yet. Items marked *pre-existing* also exist on `main`.

### Security and behavior

- **T1 — Federation trust is not anchored** (*pre-existing*). Tracked in [#1046](https://github.com/openwallet-foundation/eudiplo/issues/1046): full trust-chain resolution, signature and anchor validation, and resolving credential keys through federation instead of the credential's own certificate.
- **T2 — Federation fetches bypass the outbound URL policy** (*pre-existing*). Traversal is now bounded (10 hints per entity, 32 resolutions per evaluation, 5 s timeout). To be handled with the resolver work in [#1046](https://github.com/openwallet-foundation/eudiplo/issues/1046): apply `OutboundUrlPolicyService` to federation fetches and stop disabling TLS verification outside `NODE_ENV=production` in `TrustModule`.
- **I2 — Explicit authorization-server selection stores a URL** (*pre-existing*). When an offer names `authorization_server`, the session's `authorizationServerId` receives the resolved issuer URL instead of the configured id (`SelectAuthorizationServer`). Decide which value consumers expect.

### Cleanup

- **O4** `IssuanceService.reissueRegistrationCertificate` duplicates the registration-certificate material, fingerprint and JWT-window helpers; reuse `oid4vci/domain/issuer-registration-certificate.ts`.
- **O5** `SessionUpdate` still accepts `status`. Verifier terminal writes keep it so status, outcome and single-use flag land in one (conditional) update, then call `ChangeSessionState.announce`; `oid4vci.service.ts` sets `Fetched` without an event. Removing it needs dedicated repository transitions.

### Enforcement gaps

- **E5** Rewrite the `shared/` isolation check on the TypeScript import graph so aliases, re-exports and dynamic imports are covered.

## Next slices

Take them in this order unless a finding above is more urgent.

1. **Security findings T2, I1, V1.** Each is small and has a clear test.
2. **Enforcement E5**, so the `shared/` isolation check covers aliases and re-exports.
3. **Verifier decomposition.** Done: presentation configuration CRUD, registration certificates and metadata import (`verifier/presentations/configuration/`), `TrustedAuthoritiesService`, the DCQL claim policy, one verifier format contract used by OID4VP and ISO 18013, and the `VerifyPresentationResponse` use case (characterized in `oid4vp/presentation-verification.spec.ts`). Remaining:
   1. `Oid4vpService` shrinks to HTTP mapping: extract request creation and response decryption into use cases.
   2. `Iso18013Service`: response processing as a use case with application errors and typed settings.
   3. `SdJwtVerificationError` as a plain error mapped at the boundary.
4. **Authorization services.** Done for the built-in authorization server (`ExchangeAccessToken`, `PushAuthorizationRequest`, `AuthorizePushedRequest`, `BuildBuiltInAuthorizationServerMetadata`; `authorize.controller.spec.ts` characterizes every response). Remaining:
   1. One set of chained-AS use cases (PAR, authorize, token) shared by `ChainedAsService`, `ChainedAsVpService` and `AuthorizationServersService`, throwing `OAuthError` instead of Nest exceptions; they differ only in how the user is authenticated.
   2. `InteractiveAuthorizationService` as a use case that returns IAE responses; it currently maps `BadRequestException`s of its dependencies to `invalid_request`.
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
