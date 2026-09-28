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
| 2 | Boundary enforcement | Partial | Close the gaps listed under [enforcement gaps](#enforcement-gaps). |
| 3–4 | Session repository and lifecycle | Done | Follow-ups S1–S3 below. |
| 5–6 | OID4VCI use cases, no Express | Partial | Split `Oid4vciProtocolMetadata`, finish deferred issuance, remove forwarding wrappers. Authorization services still orchestrate in legacy services. |
| 7–9 | Issuer credential formats | Partial | Registry exists; format issuer services still take the TypeORM entity type. |
| 10–11 | Claims provider and publisher ports | Done | Unify claim-source selection between `IssueCredential` and `ConfiguredCredentialClaimsProvider`. |
| 12–13 | Trust retrieval and federation resolver | Partial | Federation trust is not cryptographically anchored (T1), traversal needs limits (T2). |
| 14 | OID4VP use cases | Partial | Request retrieval, response parsing and completion extracted; `PresentationsService` (2300 lines) untouched. |
| 15–16 | Verifier credential formats | Partial | Registry exists but formats have different `verify` signatures; ISO 18013 bypasses it. |
| 17–18 | Configuration repositories, plain models | Done for tenant, credential, issuance, attribute-provider, webhook-endpoint | Presentation, status-list, registrar, key-chain and config-portability still use TypeORM in services. Merge the three credential-config ports. |
| 19 | Client provider abstraction | Done in code | Regenerate the SDK (C7) and validate Keycloak mode against a live instance. |
| 20 | Typed settings instead of `ConfigService` | Partial | About 50 non-module files still read `ConfigService`. |
| 21 | Modules as composition roots | Partial | Applied to migrated slices. |
| 22 | Application errors instead of HTTP exceptions | Partial | Applied to migrated slices; legacy services still throw Nest exceptions. |
| 23 | Adapter contract tests | Partial | Session and configuration repositories covered on SQLite and PostgreSQL. Storage, KMS, client providers and credential formats open. |
| 24 | Pure application tests | Partial | Present for every extracted use case. |
| 25 | Final dependency audit | Open | Replace with the ratchet baseline (E1) so the audit is data, not prose. |

## Known debt

These legacy services still mix orchestration with persistence, configuration, transport or HTTP errors:

| Area | Files | Notes |
| --- | --- | --- |
| Verification | `verifier/presentations/presentations.service.ts`, `verifier/oid4vp/oid4vp.service.ts`, `verifier/iso18013/iso18013.service.ts` | Largest remaining monolith. Decomposition proposal under [next slices](#next-slices). |
| OID4VCI | `issuer/issuance/oid4vci/adapters/oid4vci-protocol-metadata.ts` (~1000 lines), `oid4vci.service.ts`, `deferred-credential.service.ts` | The metadata file was moved out of `Oid4vciService` without being decomposed. Deferred issuance writes through both the port and a raw TypeORM repository. |
| Authorization | `issuer/issuance/oid4vci/authorization/**` | `authorize.service.ts`, `interactive-authorization.service.ts`, `chained-as.service.ts`, `authorization-servers.service.ts`. |
| Other capabilities | `issuer/status-list/`, `crypto/key/`, `registrar/`, `platform/config-portability/`, `audit-log/`, `storage/files.service.ts` | Not yet in scope of any slice. |

Rough size of the remaining work: about 50 non-module files read `ConfigService`, and 27 services outside `adapters/` use `@InjectRepository`.

## Open review findings

Findings from the 2026-09-28 review that are not fixed yet. Items marked *pre-existing* also exist on `main`.

### Security and behavior

- **T1 — Federation trust is not anchored** (*pre-existing*). The entity ID is taken from the credential's own certificate, and nothing binds the credential key to that entity's federation keys. The new `x5c` signature check verifies an entity configuration only against its own embedded certificate, and unsigned JSON or JWT responses are still accepted. Either implement OpenID Federation chain validation (entity self-signature against `jwks`, subordinate statements, configured anchor keys; reject unsigned responses) or document federation-only trust as unauthenticated.
- **T2 — Federation traversal fan-out.** `EvaluateFederationTrustChain` follows every `authority_hints` entry up to depth 8, without limits on hint count, total fetches or request timeouts, and without the outbound URL policy. An attacker-controlled entity configuration can make the backend fetch arbitrary hosts.
- **V1 — OID4VP replay check is not atomic** (*pre-existing*). `consumed` is read early and written after verification, so two concurrent responses can both complete and both trigger webhooks. Use a conditional update.
- **V2 — Verifier terminal states bypass `ChangeSessionState`** (*pre-existing*). OID4VP and ISO 18013 set `Completed`/`Failed` through generic updates, so no SSE event or metric is emitted. `SessionUpdate` should not accept `status`.
- **I1 — Credential nonce consumption race** (*pre-existing*). `ValidateAndConsumeCredentialNonces` ignores the result of `delete()`, so two concurrent requests can use one nonce.
- **S1 — Whole `SESSION_REPOSITORY` exported.** Importers get privileged cross-tenant maintenance operations. Export use cases or a narrower port.
- **C7 — Client API schema rename.** Swagger now names `ClientResponseDto` instead of `ClientEntity`. Regenerate `packages/eudiplo-sdk-core` and update `apps/client` in the same change.

### Cleanup

- **O1** Split `Oid4vciProtocolMetadata` into authorization-server selection, an external AS metadata resolver (cache and federation check), a registration-certificate provider port, and a `BuildIssuerMetadata` use case. Replace its `BadRequestException`s with application errors.
- **O2** Finish deferred issuance: all persistence through `DeferredTransactionRepository`, reuse the proof verifier and authorization-details use case, and unify resource-token verification for the credential, notification and deferred endpoints.
- **O3** Remove forwarding wrappers in `Oid4vciService` and unused providers in `issuance.module.ts`.
- **S2** Replace the seven near-identical `GetSession*` use cases with one lookup service, and build session retention settings once.
- **CF1** Merge `CredentialConfigRepository`, `CredentialConfigurationRepository` and `CredentialClaimsConfiguration` into one port; inject `AttributeProviderRepository` instead of constructing it.
- **CF2** Type `SdjwtvcIssuerService` and `MdocIssuerService` on the plain `CredentialConfiguration` model instead of casting.

### Enforcement gaps

- **E1** Add a ratchet baseline: a checked-in list of legacy files that still import `@nestjs/config`, TypeORM, Express or Nest HTTP exceptions. The test fails on new entries and on stale ones.
- **E2** Adapters may not import controllers, modules or another capability's adapters.
- **E3** Controllers may not import `adapters/` and should stop importing entities.
- **E4** Forbid `class-validator`, `class-transformer`, `nestjs-zod` and `nestjs-pino` in core code. Move `AuthResponseSchema` out of the OID4VP DTOs into the verifier domain.
- **E5** Rewrite the `shared/` isolation check on the TypeScript import graph so aliases, re-exports and dynamic imports are covered.

## Next slices

Take them in this order unless a finding above is more urgent.

1. **Security findings T2, I1, V1.** Each is small and has a clear test.
2. **Enforcement E1–E3**, so later slices cannot move code into unchecked places.
3. **OID4VCI O1–O3.**
4. **Verifier decomposition**, in these steps:
   1. Presentation configuration management behind a `PresentationConfigRepository` port.
   2. Registration certificates behind a `RegistrationCertificateIssuer` port.
   3. Schema metadata behind a `SchemaMetadataResolver` port.
   4. DCQL claim policy as pure domain code (completeness, claim-set matching).
   5. One `CredentialVerifierFormat.verify` signature, with mdoc transcript and SD-JWT key binding inside the adapters; ISO 18013 uses the registry.
   6. `VerifyPresentationResponse` and `ProcessPresentationResponse` use cases; `Oid4vpService` shrinks to request creation and HTTP mapping.
5. **Authorization services**: token, PAR and pre-authorized flows as use cases with OAuth-specific application errors and typed settings.
6. **Contract tests (Task 23)** for storage, KMS and client providers.
7. **T1** once the federation trust model is decided.

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
