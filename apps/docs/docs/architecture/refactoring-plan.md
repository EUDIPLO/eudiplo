# EUDIPLO Architecture Hardening Backlog

## Status and execution scope

Implementation started following the architecture review. Documentation adoption and incremental boundary enforcement are complete; credential-offer retrieval, state changes, cleanup, maintenance initialization, tenant listing/deletion, and failed transaction-code counting are implemented. The broader migration remains in progress.

### Delivered slice: endpoint models and claims resolution — 2026-09-28

Attribute-provider and webhook-endpoint repositories now expose plain capability models and explicitly tenant-scoped operations. TypeORM implementations live in adapters, and services/module wiring use the new contracts. Shared persistence tests run against SQLite and PostgreSQL, covering tenant isolation, JSON authentication data, plain result mapping, merged updates, explicit nulls, and repeated deletion.

`ConfiguredCredentialClaimsProvider` now lives in `application/` and depends only on configuration lookup, attribute-provider lookup, and remote-claims ports. TypeORM configuration lookup and webhook delivery/response normalization live in separate adapters. Inline and offer-time sources retain precedence, required-provider errors remain transport-neutral, and the existing HTTP delivery implementation retains URL-policy and authentication handling. Pure tests cover source selection, missing/optional providers, failures, and deferred responses; production-module integration covers persisted configuration lookup, delivery wiring, and wrong-tenant rejection.

`DeferredTransactionStatus` now belongs to the domain. The two endpoint-port and four deferred-lifecycle architecture exceptions have been removed. Tenant, general credential configuration, credential-management configuration, and issuance configuration repository exceptions remain open; this slice does not complete Tasks 17–18 or 25.

Validation: backend build, lint, format check, all 473 unit tests, and 22 isolated integration tests pass. Integration covers PostgreSQL endpoint contracts, production-module claims/session wiring, and credential-offer endpoints; SQLite contracts run in the unit suite. No database schema or migration changed.

### Review corrections — 2026-09-27

Addressed the four review findings:

- Federation traversal checks direct anchors before other hints and explores alternate branches after dead ends, cycles, subject mismatches, or fetch failures. The depth limit remains eight; fetch failures still propagate to the existing stale-cache handler when no path succeeds.
- OID4VP schema parsing remains separate from state validation. State mismatches run through the existing response-failure handler, restoring failed-session persistence, response-key cleanup, audit logging, and configured error redirects.
- Credential-notification endpoint lookup ignores only a missing endpoint. Storage failures propagate and prevent webhook publication and the later session-state transition.
- The internal-JWKS unit fixture supplies typed settings instead of the removed configuration-service dependency.

Validation: backend build, lint, format check, and all 462 unit tests pass. New regressions cover alternate federation paths and depth limits, OID4VP failure cleanup with/without redirects, and notification lookup failures and operation ordering. Integration suites were not rerun for these corrections.

### Implementation status

| Tasks            | Status                                            | Delivered / remaining                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1                | Complete                                          | Target roles, placement, dependency direction, and contributor instructions adopted.                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2                | Complete for incremental migration                | TypeScript-aware boundary checks run in the existing CI unit suite; enforcement scope and legacy exceptions are documented in the target architecture.                                                                                                                                                                                                                                                                                                                                |
| 3                | Complete for current session operations           | `SessionRepository` and `TypeOrmSessionRepository` cover create/update, tenant and protocol-specific lookups, offer retrieval/consumption, state/key updates, expiry selection, retention, maintenance counts, tenant listing/deletion, failed transaction-code counting, and external-AS binding. The generic `SessionService` has been removed; callers use focused application operations.                                                                                         |
| 4                | Complete for lifecycle and maintenance            | Application use cases own state changes, retention policy, and initial metric-count orchestration. Adapters own persistence, tenant-policy loading, events, metrics, and scheduling. Remaining CRUD migration is tracked in Task 3.                                                                                                                                                                                                                                                   |
| 5–6              | Incremental; deferred lifecycle extracted         | Credential-offer retrieval, grant construction, credential identifier/authorization-details resolution, authorization-server token classification, nonce proof validation/consumption, credential-notification recording, nonce persistence lifecycle, deferred retrieval, completion, and failure operations are explicit. Request authentication, HTTP mapping, offer persistence/SDK orchestration, and most credential issuance orchestration remain in framework-bound services. |
| 18, 20–24        | Applied to this slice                             | Plain offer/lifecycle models, typed offer/scheduling settings, composition-root wiring, transport-independent errors, shared SQLite/PostgreSQL contracts, and pure application tests. Broader adoption remains pending.                                                                                                                                                                                                                                                               |
| 10–11, 22        | Claims resolution and publisher ports extracted   | `CredentialClaimsProvider`, `CredentialNotificationPublisher`, and `PresentationResultPublisher` are explicit business ports with configured/HTTP adapters. Claims configuration failures are transport-neutral inside the provider and mapped at OID4VCI. Claim-source selection now uses plain lookup and remote-delivery ports with pure and module-wiring tests. Other generic webhook usages remain pending.                                                                     |
| 12–13            | Federation retrieval and chain evaluation started | Federation policy/cache evaluation consumes `FederationResolver`; authority-hints traversal is bounded and cycle-safe, and signed `x5c`-backed entity configuration JWTs are verified by the resolver. Full federation metadata/policy cryptography and trust-anchor certificate validation remain open.                                                                                                                                                                              |
| 7–8, 15–16       | Issuer and verifier format registries implemented | Issuance and presentation verification dispatch through explicit SD-JWT VC and mdoc format adapters. Format-specific services retain cryptographic implementation; deeper verifier policy extraction and parity tests remain open.                                                                                                                                                                                                                                                    |
| 19               | Client model boundary implemented for consumers   | Client provider/token contracts use plain `ClientData`/`CreatedClient`; Internal and Keycloak adapters map persistence entities to those models, and client API Swagger responses use a DTO. Import lifecycle registration lives in `ClientModule`. Internal-auth and startup-import E2E pass; live Keycloak-mode validation remains pending.                                                                                                                                         |
| 14               | First OID4VP application operation extracted      | Cached presentation-request retrieval and persistence is a pure use case; cryptographic request creation and presentation response processing remain in `Oid4vpService`.                                                                                                                                                                                                                                                                                                              |
| 15–16            | Initial verifier format boundary implemented      | mDOC and SD-JWT-VC verification dispatch through `CredentialVerifierFormatRegistry`; presentation orchestration still owns claim selection and trust policy. Deeper policy extraction and adapter contracts remain open.                                                                                                                                                                                                                                                              |
| 17–18, 20–22, 24 | Incremental                                       | Repository ports now cover tenant, issuance, credential configuration, attribute provider, and webhook endpoint aggregates; typed settings cover trust, wallet attestation, status lists, credentials, and OID4VCI URLs. Attribute-provider and webhook-endpoint ports now return plain models; tenant, credential, and issuance entity leaks, additional transport-independent errors, and broader contract tests remain.                                                            |
| 23               | Partial                                           | The shared session repository contract runs against PostgreSQL; an in-memory SQLite runner now executes the same 28 cases. Endpoint repository contracts also run against SQLite and PostgreSQL. Other interchangeable adapters still need contracts.                                                                                                                                                                                                                                 |
| 25               | In progress                                       | The classified audit is updated incrementally as boundaries move. A clean final audit and sign-off are not claimed until remaining legacy orchestration and entity leaks are addressed.                                                                                                                                                                                                                                                                                               |
| All other tasks  | Pending                                           | No claim of completion outside the slices above. Remaining work is tracked under Tasks 5–6, 17–19, 23–25 and the open-work section below.                                                                                                                                                                                                                                                                                                                                             |

### Delivered slice: credential offers by reference

The public `GET /issuers/:tenantId/vci/credential-offers/:sessionId` route now calls `RetrieveCredentialOffer` through `CredentialOfferReferenceController`. The use case depends on a session port; persistence remains in a TypeORM adapter. The old methods in `Oid4vciService` and `SessionService` were removed, not retained as wrappers.

No database schema or migration changed. Lookup-error mapping, HTTP response bodies, tenant scope, single/multiple consumption, encrypted offer storage, first-consumption timestamps, and the separate `consumed` flag retain their existing behavior. In multiple-consumption mode, an existing session with a null offer still produces an empty 200 response; changing this behavior is a separate decision.

Validation: backend build, lint, format check, full unit suite, shared repository contract against real SQLite and PostgreSQL, and HTTP regression tests through the production NestJS module graph with isolated test storage.

### Delivered slice: session state changes and maintenance adapters

`ChangeSessionState` replaces `SessionService.setState` at both callers: OID4VCI notification handling and scheduled presentation expiry. `SessionStatus` and terminal-key cleanup rules now live in a framework-independent domain module. Existing enum imports were updated rather than kept behind a compatibility re-export.

The state operation uses an explicitly tenant-scoped repository update, then publishes synchronously through `SessionEventPublisher`, then records metrics through `SessionMetrics`. Terminal updates clear the private response encryption key in the same database update; nonterminal updates preserve it. The public SSE shape remains unchanged. The unused internal full-session event payload was removed so the application contract does not carry entities or private session data.

`NestSessionEventPublisher` and `OtelSessionMetrics` own their concrete libraries. `SessionMaintenanceJob` owns interval registration and initial metric counts, using typed interval settings assembled in `SessionModule`; cleanup persistence has since moved to the repository adapter in the slice below. The interval name, startup count/cleanup order, metric name and labels, and existing counter deltas are preserved.

Characterization tests passed against the old state operation before extraction, then against the extracted operation and adapters. Validation passed: backend build/lint/format, 326 unit tests, and 22 focused integration tests covering PostgreSQL repository behavior, production module wiring, expiry/SSE, and the earlier offer endpoint.

Existing semantics intentionally retained: state updates do not add compare-and-set, transition deduplication, or new missing-row errors; repeated calls still publish and record the existing counter deltas. Any concurrency/idempotency policy change needs its own behavioral task. Generic `SessionService.add` callers remain outside this migrated operation.

### Delivered slice: cleanup, expiry, and initial metric counts

`CleanupSessions` now applies retention policy through repository operations and `SessionRetentionPolicies`. `InitializeSessionMetrics` initializes the existing tenant/status/type buckets through ports. `SessionMaintenanceJob` only schedules and invokes these use cases; it no longer imports TypeORM or `SessionService`. The obsolete `SessionService.tidyUpSessions` and private cleanup methods were removed and all callers updated.

Retention defaults are typed settings assembled in the module. Tenant overrides are loaded fresh each run through `TypeOrmSessionRetentionPolicies`, which returns plain policy values rather than entities. `SessionCleanupMode` moved into the session domain, with all imports updated. The repository adapter owns expiry selection, tenant-scoped deletion/anonymization, orphan deletion, counts, and per-operation cleanup logs.

Preserved behavior: expiry/state effects finish before retention cleanup; tenant values override defaults per field; retention uses creation time with a strict cutoff; anonymization clears the same six fields to SQL NULL and is repeatable; the empty-tenant guard prevents broad orphan deletion; orphan cleanup uses the default TTL. Existing date-column precision, failure propagation, and scheduling/concurrency semantics remain unchanged. No schema migration was introduced.

Validation passed: backend build/lint/format, 340 unit tests, and 29 focused integration tests. Shared SQLite/PostgreSQL contracts cover expiry filters, strict cutoffs, tenant isolation, raw SQL NULLs, retry no-ops, orphan guards, metric bucket counts, and fresh policy mapping. Production module tests cover tenant overrides and policy changes between cleanup runs, expiry/SSE, and the existing offer endpoint.

### Delivered slice: tenant session listing and deletion

`ListSessions` and `DeleteSession` now serve the existing controller routes through explicit tenant-scoped repository operations. The obsolete service methods were removed. Listing returns a plain four-field summary, with pagination metadata assembled by the application use case; HTTP validation remains in the query DTO. Deletion still silently succeeds for missing rows and wrong-tenant IDs, with the same 204 endpoint.

The database contract exposed an existing TypeORM projection/count issue: counting selected nullable columns could omit issuance sessions when a full page required a count query. The adapter now counts matching rows separately, so totals include sessions whose request ID is null. Filtering, sorting (including the default updatedAt descending), page selection, and response fields remain unchanged.

Validation covers empty and out-of-range pages, tenant isolation, issuance/presentation classification (including an empty non-null request ID), status filters, ordering, plain summary projections, repeated deletes, and persistence failures. Shared contracts pass on SQLite and PostgreSQL; production-module controller wiring and existing lifecycle/offer regressions pass (32 integration tests).

### Delivered slice: failed transaction-code attempts

`RecordFailedTxCodeAttempt` records a failed transaction code through an explicit repository operation and evaluates the lockout threshold. The authorization caller passes its tenant scope and configured limit. The default remains five attempts; OAuth error mapping and logging stay in the existing authorization service. The obsolete `SessionService.incrementTxCodeFailedAttempts` method was removed.

The adapter atomically increments the stored counter, then reads only the ID and count without eager relations. Both operations use the same tenant scope. As before, concurrent callers may observe the same final count; the operation does not allocate unique attempt numbers or serialize the entire token flow. Missing targets produce a transport-independent application error rather than leaking TypeORM errors.

Validation passed: 355 unit tests, 36 session integration tests, backend build, lint, and format checks. SQLite/PostgreSQL contracts cover tenant isolation, missing targets, sequential counts, preserved session fields, and concurrent increments. Production module tests exercise the real counter through authorization orchestration with stubbed protocol verification: unrelated verification failures do not increment, wrong codes retain their error, reaching the limit returns the existing invalid-grant description, and already-locked sessions skip verification.

### Delivered slice: session operations and removal of SessionService

All remaining session operations have been moved behind explicit `SessionRepository` capabilities and focused application use cases. Tenant-scoped reads, authorization-code/refresh-token/PAR lookups, wallet nonce and internal correlation, ISO 18013 lookup, external authorization binding, creation, and tenant-scoped updates no longer depend on the generic `SessionService`; that class and its tests were removed. `CreateSession` preserves metrics from the persisted result, and update/read operations keep explicit tenant scope and existing transport/protocol error mapping at callers.

Validation passed: backend build, 46 focused unit/boundary tests, and 42 integration tests across session lifecycle, credential-offer retrieval, authorization-code and refresh-token issuance, chained authorization, mdoc issuance, presentation offers, and presentation webhooks. No schema or migration changed. Earlier shared SQLite/PostgreSQL repository contracts continue to cover persistence behavior.

Next slice: decompose the next OID4VCI workflow under Tasks 5–6 into an independently testable use case while preserving external protocol behavior and transport-level error mapping.

### Delivered slice: credential notification recording

`RecordCredentialNotification` now finds and updates the requested notification through `UpdateSessionForTenant`. The use case returns the persisted notification for subsequent webhook delivery. OID4VCI still owns request authentication, trace/audit logging, endpoint lookup, webhook publication, protocol error mapping, and the later session-state transition. Persistence remains before webhook delivery, and state transition remains after successful webhook delivery, as before. An unknown notification maps to the same HTTP 400 message.

Validation passed: focused use-case tests, architecture-boundary tests, backend build, Biome checks, and 8 integration tests across authorization and session lifecycle. No protocol contract or schema changed.

### Delivered slice: credential nonce persistence boundary

`CredentialNonceRepository` now owns nonce persistence for proof issuance/consumption, authorization attestation challenges, and deferred proof consumption. The TypeORM entity is registered in one capability module; `NonceService` no longer imports TypeORM or owns a scheduler, and `CredentialNonceCleanupJob` preserves the existing ten-minute cleanup cadence. Tenant scoping, ten-minute expiry, delete-on-expiry behavior, single-use deletion, error descriptions, and audit logging remain unchanged.

Validation passed: nonce unit tests, backend build, Biome checks, architecture-boundary coverage, and 23 integration tests spanning authorization, pre-authorized issuance, refresh tokens, and deferred issuance. No schema or API changes.

### Delivered slice: credential claims provider

`CredentialClaimsProvider` now owns claim-source resolution for OID4VCI: inline claims take precedence, followed by an offer-time webhook or attribute-provider reference, then the configured credential attribute provider. `ConfiguredCredentialClaimsProvider` delegates HTTP delivery and outbound URL policy to `WebhookService` and returns a business-oriented result (`claims`, `deferred`, `interval`) rather than `ClaimsWebhookResult`. The external-authorization requirement and existing conflict errors remain at the same flow boundary. Credential format issuance and the separate direct-issuance webhook fallback remain unchanged.

Validation passed: provider unit tests, architecture-boundary tests, backend build, and 28 integration tests across pre-authorized claims, deferred issuance, and chained authorization. No API, configuration, or schema changes.

Claims-provider failures now use `CredentialClaimsResolutionError` rather than Nest HTTP exceptions. OID4VCI maps these application errors to the existing conflict status and messages at the protocol boundary. Provider/boundary tests and backend build pass; the latest claims E2E rerun remains pending in an environment with valid upstream test-client headers.

### Delivered slice: presentation result publisher

OID4VP and ISO 18013 now publish verified presentation results through `PresentationResultPublisher`. Its webhook adapter preserves the existing payload, raw-presentation pass-through policy, `expectResponse: false`, delivery timing, error swallowing/logging at each existing caller, and redirect-URI response behavior. The port exposes only the redirect result consumed by these flows.

Validation passed: adapter and boundary tests, backend build, and 14 presentation-webhook, presentation-offer, and mdoc integration tests. No protocol or persistence changes.

### Delivered slice: federation entity-configuration resolver

`FederationTrustService` now uses a `FederationResolver` port for entity-configuration retrieval. `OpenIdFederationResolver` owns the `/.well-known/openid-federation` HTTP request and normalization of JSON, compact JWT, and wrapped entity-configuration responses. Anchor matching, authority-hint policy, metrics, caching, stale fallback, and trust result reasons remain in the trust service. This is not yet a cryptographic trust-chain resolver; current trust evaluation semantics are unchanged.

Validation passed: federation resolver and trust-cache unit tests, backend build, and 4 federation issuance/presentation integration tests. No schema or public API changes.

### Delivered slice: credential issuer format registry

`CredentialsService` now resolves issuance through `CredentialIssuerFormatRegistry` rather than branching on mdoc versus SD-JWT. `SdjwtvcCredentialIssuerFormat` and `MdocCredentialIssuerFormat` translate a shared plain issuance context to the existing format services; claims resolution, trust policy, and format-specific cryptographic code remain in their existing owners. Unsupported registered formats produce an application error. There is no configuration or protocol change.

Validation passed: registry and boundary tests, backend build, and 27 auth, pre-authorized, mdoc, and deferred issuance integration tests.

### Delivered slice: client importer composition

`ClientsProvider` no longer registers itself with `ConfigImportOrchestratorService` from its base constructor. `ClientModule` selects the Internal or Keycloak provider and explicitly registers that provider's tenant import function at the existing `CORE` phase. Both adapters retain their existing import implementation and bootstrap behavior.

Validation passed: backend build and 7 startup config-import integration tests. The OIDF issuance/presentation suites were not run by the configured test project in this command; they remain available under their separate OIDF test configuration. `ClientEntity` leakage and provider naming are still open under Task 19.

Client provider, controller, and JWT payload contracts now use plain models; ORM entities remain inside Internal/Keycloak adapters and tenant persistence. The public field names and one-time create-secret behavior are preserved. Validation passed: backend build, client-resource E2E (10 tests), startup config-import E2E (7 tests), focused adapter mapping tests, Biome, and boundary checks. Remaining Task 19 work is Keycloak-mode integration in an OIDC-backed environment plus any further portability/repository decoupling identified by the final audit.

## Remaining Open Work

Completed slices in this worktree cover Task 3 session repository/use-case migration, initial Task 5–6 OID4VCI operations, initial Tasks 7–8 issuer-format registry, Tasks 10–11 claims and selected publisher ports, initial Tasks 12–13 federation retrieval, initial Task 14 OID4VP request retrieval, and the client importer composition part of Task 19. These are incremental slices, not completion of their broader task groups.

Still open: decompose the remaining credential issuance orchestration; finish plain-model contracts for transitional entity-backed repository ports; complete tenant/client/configuration entity-leak cleanup; separate remaining trust policy from trust-source retrieval and validate federation trust anchors cryptographically; expand adapter contracts across persistence implementations; finish transport-independent errors and typed settings in legacy services; validate live Keycloak mode; and run the final classified dependency audit. Task 25 remains pending until these migrations stabilize.

### Delivered slice: credential batch issuance operation

`IssueCredentialsForKeys` now owns ordered credential generation for verified holder keys through a `CredentialBatchIssuer` port. OID4VCI retains proof verification, attestation trust validation, batch-size policy, audit logging, and protocol error mapping; the adapter delegates format-aware issuance to `CredentialsService`.

Validation passed: application tests (2), backend build, Biome checks, and `issuance-preauth.e2e-spec.ts` (11 tests). No protocol or persistence changes were introduced.

### Delivered slice: proof verification and credential issuance orchestration

`IssueCredentialsFromProofs` now owns prepared proof verification, trust validation through the verifier port, attested-key batch policy, ordered credential generation, and per-credential audit notification. `Oid4vciService` calls the operation directly; its redundant forwarding helper was removed. Invalid attestation-key/batch conditions use an OID4VCI-owned `InvalidCredentialProof` error mapped to the existing protocol code.

Validation passed: proof issuance/resolution unit tests (8), backend build, Biome checks, and `issuance-preauth.e2e-spec.ts` (11 tests). Existing proof order, sequential issuance, audit timing, and response behavior remain intact.

The encrypted credential-response request workaround is now an explicit, non-mutating SDK compatibility adapter: it adds the legacy sibling `alg` only when absent, preserving the wallet input and any explicit legacy value. Adapter tests (2), backend build, Biome, and pre-authorized issuance E2E (11 tests) pass.

### Delivered slice: OID4VP response parsing boundary

`ParseAuthorizationResponse` now owns decrypted OID4VP response schema validation and wallet-state validation as a transport-neutral application operation. `Oid4vpService` maps its validation errors to HTTP responses while retaining JWE decryption, credential verification, session persistence, webhook publication, and audit ordering.

Validation passed: parser tests (2), backend build, Biome checks, and `presentation-transaction-data.e2e-spec.ts` (9 tests). No protocol or persistence changes were introduced.

Successful OID4VP response completion now uses `CompletePresentationResponse`, which owns response-code persistence, terminal status, replay protection, encryption-key cleanup, and structured success provenance. `Oid4vpService` retains verification, webhook publication, redirect handling, and audit sequencing.

Validation passed: completion/parser tests (3), backend build, Biome checks, and `presentation-transaction-data.e2e-spec.ts` (9 tests).

`Oid4vpService` now receives typed `Oid4vpSettings` from `Oid4vpModule` for public URL generation, trusted-authority policy, and decrypted-response logging instead of reading these values through `ConfigService`.

Validation passed: backend build, Biome checks, and `presentation-transaction-data.e2e-spec.ts` (9 tests).

### Delivered slice: OID4VCI webhook endpoint boundary cleanup

`Oid4vciService` now resolves notification webhook endpoints through `WebhookEndpointService` rather than injecting the endpoint TypeORM repository directly. Missing or wrong-tenant endpoints retain the previous no-publication behavior; notification ordering and publisher semantics are unchanged.

Validation passed: backend build, Biome checks, diff validation, and `issuance-preauth.e2e-spec.ts` (11 tests).

### Delivered slice: typed session configuration settings

`SessionConfigService` now consumes typed `SessionSettings` assembled by `SessionModule` instead of reading `ConfigService` directly. Tenant overrides, global TTL/cleanup defaults, and the existing session configuration API remain unchanged. This deliberately avoids adding another repository wrapper; the remaining tenant entity persistence is still tracked as transitional.

Validation passed: session settings/state tests (4), backend build, Biome checks, and diff validation.

### Delivered slice: shared session logging settings

`SessionLogStoreService`, `SessionAuditService`, and `SessionLoggerService` now consume one typed `SessionLoggingSettings` object assembled by `SessionLoggingModule`. This removes repeated `ConfigService` reads without introducing separate configuration wrappers per service; logging enablement, storage mode, and verbose behavior remain unchanged.

Validation passed: backend build, Biome checks, and diff validation.

### Delivered slice: OID4VCI credential request transport context

Credential, notification, and deferred-credential endpoints now pass an `Oid4vciRequestContext` value (body, content type, headers, method, and URL) to `Oid4vciService`; deferred resource-token verification also receives that context. The controller owns encrypted-body stream handling, while OID4VCI services retain JWE decryption, DPoP/resource-token verification, issuance-set derivation, and protocol orchestration. Shared header normalization now accepts header values and preserves authorization-scheme behavior.

Validation passed: backend build, header-normalization unit tests, and architecture-boundary tests. The focused pre-authorized E2E suite started but 8 cases failed during upstream test-client access-token retrieval with invalid header values before credential request processing; 3 cases passed. Encrypted-request integration behavior therefore still needs a rerun in a correctly configured E2E environment. Authorization controllers/services continue to accept Express requests; the OID4VCI and deferred-credential services use the plain request context.

### Delivered slice: deferred credential retrieval decision

`ResolveDeferredCredentialRetrieval` now owns the framework-independent status and expiry decision for deferred credential polling. It preserves pending intervals, failure messages, expired/retrieved errors, missing-ready-credential handling, and the ready credential result. `DeferredCredentialService` retains protected-resource authentication and repository updates, including marking expired transactions and atomically changing ready transactions to retrieved.

Validation passed: pure retrieval-decision tests, existing proof/nonce tests (12 total), backend build, and Biome checks. No protocol, persistence, or schema behavior changed.

### Delivered slice: deferred credential lifecycle ports

Deferred completion and failure now use plain application operations backed by a `DeferredTransactionRepository` port. The TypeORM adapter maps persistence entities to plain transaction data, while a credential-issuer adapter keeps format-specific credential generation behind the application boundary. Tenant scoping, pending-only completion, credential issuance, failure-message defaults, and controller response fields remain unchanged.

Validation passed: deferred lifecycle unit tests (6), backend build, Biome checks, and the deferred credential E2E suite (8 tests). No schema or public protocol changes were introduced.

### Delivered slice: PAR request transport context

The OID4VCI PAR service method now receives the existing plain `Oid4vciRequestContext` instead of an Express request. The controller remains responsible for adapting HTTP method, URL, headers, and content type; PAR validation, DPoP verification, client-attestation handling, request-URI persistence, and OAuth error mapping remain in the authorization service. Token-request and interactive authorization methods are intentionally outside this slice and remain Express-coupled.

Validation passed: backend build and Biome checks. The focused authorization E2E suite could not start because its shared port 3000 was repeatedly claimed by another process before Nest initialization; no PAR test assertions executed.

### Delivered slice: authorization token request transport context

The OID4VCI token endpoint now passes `Oid4vciRequestContext` into `AuthorizeService.validateTokenRequest`. The controller adapts the HTTP request, while token parsing, authorization-code/pre-authorized-code/refresh-token verification, DPoP handling, wallet attestation, PKCE, transaction-code lockout, and response generation remain unchanged. The authorization service no longer imports Express for PAR or token processing.

Validation passed: backend build, Biome checks, and focused application regressions. The authorization E2E suite remained blocked before test setup by a competing listener on port 3000; no token-flow assertions executed in this run.

### Delivered slice: interactive authorization transport context

Interactive authorization parsing and handling now receive `Oid4vciRequestContext` instead of Express `Request`. The controller adapts the request, while client-attestation and DPoP header extraction, initial/follow-up interaction routing, and web authorization behavior remain in the service. Web authorization completion remains unchanged.

Validation passed: backend build, Biome checks, and `issuance-iae.e2e-spec.ts` (20 tests). No protocol or persistence changes were introduced.

### Delivered slice: chained-AS discovery resolver

Chained-AS OIDC discovery now uses an `OidcDiscoveryResolver` port with an HTTP adapter. `ChainedAsService` retains cache expiry, in-flight request deduplication, metrics, federation policy checks, and stale-document fallback; direct HTTP remains only for the separate upstream token exchange path.

Validation passed: chained-AS discovery unit tests (3), backend build, Biome checks, and `issuance-chained-as.e2e-spec.ts` (9 tests). No protocol or persistence changes were introduced.

### Delivered slice: chained-AS token exchange adapter

Chained-AS upstream authorization-code exchange now uses an `OidcTokenExchanger` port with an HTTP adapter. The adapter owns form encoding and upstream response mapping; `ChainedAsService` retains PKCE/session handling and JWT claim decoding. Client credentials, redirect URI, and token-exchange error propagation remain unchanged.

Validation passed: token-exchange and discovery unit tests (4), backend build, Biome checks, and `issuance-chained-as.e2e-spec.ts` (9 tests). No protocol or persistence changes were introduced.

### Delivered slice: verifier format registry

Presentation verification now dispatches mDOC and SD-JWT-VC through `CredentialVerifierFormatRegistry` and explicit format adapters. Existing mDOC transcript construction, SD-JWT key binding, claim-set matching, trust policy, and failure mapping remain in `PresentationsService`; the adapters only own format-specific verifier invocation.

Validation passed: registry tests (2), backend build, Biome checks, mDOC presentation E2E (5 tests), and SD-JWT presentation E2E (5 tests). No protocol or persistence changes were introduced.

### Delivered slice: trust-store typed settings

`TrustStoreService` now receives typed `TrustStoreSettings` from `TrustModule` instead of reading `ConfigService` directly. Managed trust-list URL construction preserves the internal URL preference, public URL fallback, tenant encoding, and trust-list identifier encoding.

Validation passed: trust-store tests (2), backend build, and Biome checks. No trust-list or persistence behavior changed.

### Delivered slice: credential metadata typed settings

`CredentialsService` now receives typed `CredentialSettings` from `CredentialIssuanceModule` instead of reading `PUBLIC_URL` through `ConfigService`. Hosted SD-JWT VCT URL generation and the credential metadata endpoint preserve their existing paths and response behavior.

Validation passed: credential service unit tests (6), credential claims/metadata E2E (4 tests), backend build, and Biome checks. No schema or protocol changes were introduced.

The SD-JWT issuer now consumes the same typed credential settings for hosted VCT and issuer URLs rather than reading `ConfigService` directly. Existing credential issuance URL behavior is unchanged; backend build and Biome checks pass.

### Delivered slice: status-list typed settings

`StatusListService` now receives typed `StatusListSettings` from `StatusListModule` for public URLs, default capacity, and default bits-per-status. Tenant-specific status-list overrides remain authoritative, while global defaults and generated status-list URLs preserve their existing behavior.

Validation passed: status-list unit tests (16), backend build, Biome checks, and diff validation. No schema or protocol changes were introduced.

Wallet attestation now receives typed `WalletAttestationSettings` for crypto tolerance from `TrustModule` rather than reading `ConfigService` directly. Its focused tests (4), backend build, and Biome checks pass; attestation protocol behavior is unchanged.

### Delivered slice: federation trust-chain evaluator

Federation trust evaluation now delegates authority-hints traversal to `EvaluateFederationTrustChain`. The evaluator follows intermediate entities with a bounded depth, validates subject/entity consistency, detects cycles, and preserves configured-anchor handling. `FederationTrustService` retains cache, negative-cache, metrics, and stale fallback behavior; retrieval remains behind `FederationResolver`.

Validation passed: federation chain and trust-cache tests (7), backend build, Biome checks, and diff validation. This improves chain traversal but does not yet provide cryptographic verification of signed federation entity configurations.

Signed federation entity configurations carrying an `x5c` header are now verified with JOSE signature validation against the leaf certificate before their claims are used for chain traversal. Legacy JSON and unsigned compact fixtures remain supported for compatibility; configured production federation documents should use signed `x5c`-backed JWTs.

Validation passed: federation resolver, chain, and trust-cache tests (11), backend build, Biome checks, and diff validation.

### Delivered slice: credential configuration repository port

`CredentialConfigService` now accesses credential configuration persistence through `CredentialConfigRepository`; `TypeOrmCredentialConfigRepository` owns the TypeORM adapter and tenant-scoped persistence delegation. Controllers, DTOs, import behavior, and entity schema remain unchanged.

Validation passed: repository adapter test (1), backend build, Biome checks, and diff validation.

### Delivered slice: attribute-provider repository port

`AttributeProviderService` now accesses tenant-scoped persistence through `AttributeProviderRepository`; `TypeOrmAttributeProviderRepository` owns the TypeORM adapter. Import, outbound URL validation, audit logging, tenant isolation, and controller behavior remain unchanged.

Validation passed: repository adapter test (1), backend build, Biome checks, and diff validation.

### Delivered slice: webhook endpoint repository port

`WebhookEndpointService` now accesses tenant-scoped persistence through `WebhookEndpointRepository`; `TypeOrmWebhookEndpointRepository` owns the TypeORM adapter. Import behavior, outbound URL validation, audit logging, and controller contracts remain unchanged.

Validation passed: repository adapter test (1), backend build, Biome checks, and diff validation.

### Delivered slice: issuance configuration repository port

`IssuanceService` now accesses tenant-scoped issuance configuration persistence through `IssuanceConfigRepository`; `TypeOrmIssuanceConfigRepository` owns the TypeORM adapter. Configuration import, normalization, audit logging, and controller behavior remain unchanged.

Validation passed: repository adapter test (1), backend build, Biome checks, and diff validation.

### Delivered slice: combined credential configuration repository port

`CredentialsService` now reads credential configurations and referenced attribute providers through `CredentialConfigurationRepository`; the TypeORM adapter owns both persistence repositories and module composition. Credential format selection, claims resolution, tenant scoping, and public API behavior remain unchanged.

Validation passed: credential service and repository tests (7), backend build, Biome checks, and diff validation.

The credential-config TypeORM implementation is now located under `credential-config/adapters/`; the port file contains only the persistence contract. This is an incremental step toward replacing entity-backed contracts with plain configuration models.

### Delivered slice: tenant repository port

`TenantService` now accesses tenant persistence through `TenantRepository`; `TypeOrmTenantRepository` owns the TypeORM adapter. Tenant setup/import, client creation, lifecycle events, audit logging, cascading deletion, and controller behavior remain unchanged.

Validation passed: tenant service and repository tests (4), backend build, Biome checks, and diff validation.

### Delivered slice: OID4VP presentation-request retrieval

`RetrievePresentationRequest` owns the cached request behavior: return the stored JWT unchanged, clear redirect state for no-redirect requests, or invoke the existing request builder and persist the generated JWT. OID4VP still owns session lookup, tracing, signing, nonce/key generation, protocol construction, and transport headers. The builder callback preserves the previous sequencing and stable request object.

Validation passed: pure use-case and boundary tests, backend build, and 13 presentation-offer/transaction-data integration tests. No HTTP contract or persisted schema changed.

### Delivered slice: OID4VCI credential-offer grant construction

`BuildCredentialOfferGrants` now owns the deterministic authorization-code versus pre-authorized-code payload construction, including existing tx-code numeric/text classification, length, optional description, and omitted-tx-code behavior. `Oid4vciService` still owns ID generation, authorization-server selection, inline-claim validation, session persistence, SDK offer creation, and protocol error mapping.

Validation passed: grant behavior and architecture-boundary unit tests, backend build, authorization-code flow (1 test), and pre-authorized flow (11 tests). The E2E files were run sequentially because their test harnesses both bind port 3000.

### Delivered slice: credential authorization-details resolution

`ResolveAuthorizedCredentialConfiguration` now resolves either a direct configuration ID or a `credential_identifier` mapped through the access token's `authorization_details`, then enforces that the requested configuration is authorized. The use case is framework-independent and returns a transport-neutral error; `Oid4vciService` maps that error to the unchanged OID4VCI error code and response description.

Validation passed: focused unit/boundary tests, backend build, Biome checks, diff whitespace check, and `issuance-iae.e2e-spec.ts` (20 tests), including authorization-details behavior.

### Delivered slice: credential identifier authorization

`ResolveAuthorizedCredentialConfiguration` now resolves the direct configuration ID or maps an OID4VCI credential identifier through token `authorization_details`, then enforces that the resulting configuration is authorized. It returns transport-independent errors; `Oid4vciService` maps those errors to the same protocol error codes and descriptions. Tokens without authorization details retain the previous scope/legacy behavior.

Validation passed: use-case and architecture-boundary tests (10 total), backend build, and `issuance-iae.e2e-spec.ts` (20 tests), including the authorization-details regression.

### Delivered slice: proof nonce validation and consumption

`ValidateAndConsumeCredentialNonces` now owns proof nonce parsing, duplicate elimination, tenant-scoped lookup, expiry checking/deletion, and single-use deletion without Nest or HTTP exceptions. `NonceService` maps its transport-neutral errors back to the existing `CredentialRequestException` codes/messages and retains the same audit logging for unknown/expired nonces. Persistence ordering and sequential partial-consumption behavior remain unchanged.

Validation passed: pure use-case, NonceService mapping, and architecture-boundary tests (13 total), backend build, Biome checks, `issuance-auth.e2e-spec.ts` (1 test) for real nonce issuance/consumption, and the focused pre-authorized trust-proof E2E cases (2 tests).

### Delivered slice: authorization-server token classification

`ClassifyAuthorizationServerToken` now classifies local, chained/managed, and external authorization-server tokens using explicit issuer inputs. `Oid4vciService` still resolves configured issuer URLs and orchestrates each flow; only the deterministic branch decision moved to the pure operation. Local issuer precedence and the disabled-chained behavior are covered.

Validation passed: focused unit/boundary tests, backend build, Biome checks, and `issuance-chained-as.e2e-spec.ts` (9 tests).

### Delivered slice: SQLite session repository contract

Added an in-memory SQLite runner for the shared `SessionRepository` contract. It exercises the same create/update, tenant scoping, protocol lookups, external binding, failed-attempt concurrency, listing/deletion, maintenance cleanup, state/key handling, and offer consumption cases as the PostgreSQL Testcontainers runner. No production code or schema changed.

Validation passed: SQLite shared contract, 28 tests. The corresponding PostgreSQL shared contract also passed 28 tests in the prior validation run.

### Delivered slice: OID4VCI typed URL settings

`Oid4vciService` no longer injects `ConfigService` for `PUBLIC_URL` or `INTERNAL_URL`. `Oid4vciSettings` is assembled in `IssuanceModule`; public URL remains required at composition time and internal URL remains optional with the same JWKS URL fallback behavior. No endpoint URL or protocol request construction changed.

Validation passed: backend build, focused architecture/use-case tests, Biome, and diff whitespace checks. The port-3000 listener PID 57492 prevented rerunning offer E2E during this slice; prior sequential authorization/pre-authorized E2E tests passed after the grant extraction.

The phase numbers group related work; they are not a requirement to postpone tests, models, composition, or error handling. Complete one bounded vertical slice at a time. All interface snippets below are illustrative, not implementation-ready contracts.

## Repository baseline

- `apps/backend/src/platform/module-boundaries.spec.ts` already protects shared-code isolation and legacy directory placement; extend it before adding a second enforcement tool. The repository uses Biome and Vitest, not an existing ESLint boundary setup.
- `session/session.service.ts` combines TypeORM operations, lifecycle rules, scheduling, events, and metrics, and exposes TypeORM-specific types. Its atomic offer consumption and cleanup behavior need characterization before extraction.
- `issuer/issuance/oid4vci/oid4vci.service.ts` accepts Express requests. Existing `CredentialsService`, SD-JWT VC/mdoc issuer services, deferred issuance services, and attribute-provider configuration must be reused or deliberately migrated.
- `storage/storage.types.ts` and `crypto/key/kms/kms-adapter.ts` already define useful contracts. KMS implementations include PKCS#11 as well as DB, Vault, AWS, CSC, and HTTP.
- `auth/client/client.provider.ts` already abstracts internal/Keycloak providers but exposes `ClientEntity` and registers configuration import in its constructor. Task 19 should separate that lifecycle concern as well as persistence types.

Paths above are relative to `apps/backend/src/` unless fully specified. Recheck the baseline when starting implementation.

## Requirements for every implementation slice

- Characterize observable success and failure behavior before extraction, including HTTP/protocol error bodies and headers.
- Preserve public APIs, SDK/configuration formats, persisted data, tenant isolation, and security checks unless changes are explicitly in scope. Internal API changes alone do not authorize external changes.
- Include the needed portion of Tasks 18, 20, 21, 22, 23, and 24 with each slice: models, settings, composition, errors, contract tests, and pure application tests. Their later phases audit remaining coverage.
- Define transaction boundaries, atomic updates, concurrency outcomes, and event publication timing before replacing persistence. Preserve SQLite and PostgreSQL behavior; source moves alone should not generate migrations.
- Keep boundary checks incremental: identify migrated files explicitly and document existing violations with reasons and removal tasks. Fail on new violations without pretending the entire legacy backend already conforms.
- Validate with focused unit/boundary tests, backend build, lint, format check, and affected integration/E2E tests. Database adapters need real SQLite/PostgreSQL coverage; fake ports alone cannot prove concurrency behavior.

## Objective

Refactor the backend incrementally toward a maintainable hexagonal / ports-and-adapters architecture.

Breaking internal changes are allowed when they improve maintainability, testability, dependency direction, or extensibility.

Do not preserve obsolete abstractions merely for compatibility.

---

## Phase 1 — Architecture foundation

### Task 1 — Define and adopt the target backend architecture

#### Goal

Establish the target architecture before broad refactoring.

#### Scope

Document and adopt:

```text
Inbound adapter → Application / use case → Domain
                          ↓
                    Outbound port
                          ↑
                 Infrastructure adapter
```

Keep the current capability-oriented top-level layout.

Define:

- controller
- application service / use case
- domain service
- port
- adapter
- repository
- persistence entity
- application/domain model
- DTO

#### Acceptance criteria

- Target architecture is documented.
- Allowed dependency direction is clear.
- Breaking internal APIs are explicitly permitted.
- Contributors can determine where new code belongs.

---

### Task 2 — Extend automated architecture boundary enforcement

#### Goal

Prevent architectural erosion in CI.

#### Implementation

Start from `apps/backend/src/platform/module-boundaries.spec.ts`. Define how files are classified by role before imposing import rules; a service filename alone is insufficient. Cover type-only imports, re-exports, dynamic imports, and resolved local dependencies so a barrel or alias cannot bypass the boundary. Add fixture cases proving both allowed and forbidden edges.

Prefer extending the existing tests. Adopt a dedicated dependency tool only if the checks require it and the maintenance cost is justified.

Evaluate:

- `dependency-cruiser`
- `eslint-plugin-boundaries`
- Vitest-based architecture checks

#### Enforce at minimum

Application/domain code must not import:

```text
typeorm
@nestjs/typeorm
express
@nestjs/axios
AWS SDK clients
Vault clients
Keycloak admin client
```

Also enforce:

```text
controller -> application       allowed
application -> port             allowed
adapter -> application/port     allowed
application -> infrastructure   forbidden
controller -> repository        forbidden
```

#### Acceptance criteria

CI fails on new architecture violations.

Document intentional exceptions.

---

## Phase 2 — Session boundary

### Task 3 — Introduce a SessionRepository port

#### Goal

Remove TypeORM concepts from session application logic.

#### Target

```text
Session application
       ↓
SessionRepository
       ↑
TypeOrmSessionRepository
```

#### Example contract

```ts
interface SessionRepository {
    create(session: NewSession): Promise<Session>;
    findById(tenantId: string, id: string): Promise<Session | null>;
    update(tenantId: string, id: string, update: SessionUpdate): Promise<void>;
    changeStatus(
        tenantId: string,
        id: string,
        status: SessionStatus,
    ): Promise<void>;

    consumeCredentialOffer(id: string, tenantId: string): Promise<boolean>;

    findExpiredSessions(tenantId: string, before: Date): Promise<Session[]>;
}
```

Derive the final interface from actual use cases. `Session` here means an application model, not the existing decorated entity; creation must carry explicit tenant scope. Protocol lookups by opaque wallet nonce need purpose-specific contracts and authorization context rather than generic unscoped queries. Privileged cross-tenant cleanup must be explicit.

Preserve atomic offer consumption, first-consumption timestamps, failed-code counters, terminal-state key cleanup, per-tenant retention/anonymization, and the external-AS session binding rules. Specify concurrent-call outcomes and test them on both databases.

Do not expose TypeORM types.

#### Acceptance criteria

- Session application logic has no TypeORM imports.
- TypeORM behaviour is isolated in the adapter.
- SQLite/Postgres behaviour remains supported.
- Repository contract tests exist.

---

### Task 4 — Split SessionService responsibilities

#### Goal

Separate application behaviour from scheduling, metrics, persistence, and events.

#### Extract responsibilities such as

```text
SessionLifecycleService
SessionRepository
SessionCleanupJob
SessionEventPublisher
SessionMetrics
```

#### Acceptance criteria

`SessionService` or its replacement no longer owns all of:

- persistence mechanics
- scheduled cleanup registration
- metrics initialization
- event transport
- lifecycle/business rules

Session state transitions remain covered by tests.

---

## Phase 3 — Issuance core

### Task 5 — Decompose Oid4vciService into application use cases

#### Goal

Break the current large OID4VCI orchestration service into focused use cases.

#### Candidate use cases

```text
CreateCredentialOffer
RetrieveCredentialOffer
ProcessCredentialRequest
IssueCredential
ProcessDeferredCredential
CompleteDeferredCredential
HandleCredentialNotification
CreateNonce
ResolveAuthorization
ResolveCredentialClaims
```

Names may differ where the current implementation suggests better boundaries.

Do not create one large `Oid4vciPort`.

#### Acceptance criteria

- Credential issuance no longer depends on one oversized orchestration class.
- Individual use cases are independently testable.
- Oid4vciService is reduced to a small facade or removed.

---

### Task 6 — Remove Express Request from OID4VCI application logic

#### Goal

Make OID4VCI application code independent from Express.

#### Implementation

Translate HTTP input in the controller into an application command.

Example:

```ts
interface CredentialRequestCommand {
    tenantId: string;
    credentialRequest: ParsedCredentialRequest;
    authorization: VerifiedAuthorizationContext;
    proofContext: CredentialProofContext;
}
```

These placeholder types must be derived from the current flow. Do not recreate Express with a bag of headers and an unknown body. Keep the original method, externally visible URL, selected headers, and raw/encrypted payload available to the protocol adapter where required for DPoP, token, or request verification. Only construct a verified context after verification; extraction must not remove or bypass validation.

Keep in the controller:

- status codes
- response headers
- Content-Type
- `WWW-Authenticate`
- raw request transport handling

#### Acceptance criteria

No OID4VCI application/use-case code imports Express.

---

### Task 7 — Introduce credential issuance format abstractions

#### Goal

Make SD-JWT VC and mdoc first-class interchangeable credential issuance implementations.

#### Target

```text
IssueCredential use case
        ↓
CredentialIssuerFormat
   ┌────┴────┐
   │         │
SD-JWT VC   mdoc
```

#### Possible interface

```ts
interface CredentialIssuerFormat {
    readonly format: string;

    supports(configuration: CredentialConfiguration): boolean;

    validateConfiguration(configuration: CredentialConfiguration): void;

    issue(context: CredentialIssuanceContext): Promise<IssuedCredential>;

    buildMetadata(
        configuration: CredentialConfiguration,
    ): CredentialFormatMetadata;
}
```

Do not copy this interface blindly. Derive the final contract from actual usages.

Keep format-specific concepts inside the respective adapter where possible.

#### Acceptance criteria

Adding a third credential format does not require format-specific branches across multiple OID4VCI services.

---

### Task 8 — Introduce a CredentialIssuerFormatRegistry

#### Goal

Centralize format resolution.

#### Target

```ts
interface CredentialIssuerFormatRegistry {
    resolve(configuration: CredentialConfiguration): CredentialIssuerFormat;
}
```

Register implementations using NestJS dependency injection.

#### Acceptance criteria

- OID4VCI orchestration does not contain growing credential-format switch statements.
- Unsupported formats produce a clear application/protocol error.
- Registry behaviour is tested.

---

### Task 9 — Separate credential creation from OID4VCI transport

#### Goal

Allow credential generation independently from OID4VCI.

#### Target

```text
OID4VCI
   ↓
IssueCredential
   ↓
CredentialIssuerFormat
   ↓
SD-JWT VC / mdoc
```

#### Acceptance criteria

Credential generation can be tested without constructing an OID4VCI HTTP request.

Credential format logic can be reused by future entry points.

---

### Task 10 — Introduce a CredentialClaimsProvider port

#### Goal

Decouple claim resolution from HTTP webhooks.

#### Possible contract

```ts
interface CredentialClaimsProvider {
    resolveClaims(
        request: CredentialClaimsRequest,
    ): Promise<CredentialClaimsResult>;
}
```

#### Potential adapters

```text
ConfiguredClaimsProvider
HttpWebhookClaimsProvider
future database-backed provider
future n8n/workflow provider
future custom plugin
```

#### Acceptance criteria

Claim resolution no longer exposes HTTP webhook concepts through `CredentialsService.getClaimsFromWebhook` or `ClaimsWebhookResult`. Reuse the existing attribute-provider configuration and preserve configured claims, deferred results, validation, request authentication, and outbound URL policy. Do not add a parallel claims configuration system.

Notification delivery is migrated separately under Task 11.

---

### Task 11 — Split webhook responsibilities into domain-specific ports

#### Goal

Avoid one generic webhook abstraction for unrelated business actions.

#### Candidate ports

```text
CredentialClaimsProvider
CredentialNotificationPublisher
PresentationResultPublisher
```

HTTP webhook implementations may implement these ports. Preserve current payloads, authentication, retry/failure behavior, and delivery timing; do not introduce an outbox or change delivery guarantees without a separate requirement.

Do not introduce a generic application-level `HttpClient` as the main abstraction.

#### Acceptance criteria

Application code expresses business intent rather than HTTP intent.

---

## Phase 4 — Trust architecture

### Task 12 — Separate trust evaluation from trust retrieval

#### Goal

Decouple trust decisions from networking and caching.

#### Potential components

```text
TrustEvaluator
TrustSource
FederationResolver
TrustListProvider
CertificateTrustValidator
```

Move remote fetching and transport concerns behind adapters where practical.

#### Acceptance criteria

Trust-policy tests run without HTTP.

Federation and LoTE trust sources can be tested independently.

---

### Task 13 — Introduce an OpenID Federation resolver port

#### Goal

Treat OpenID Federation as replaceable trust infrastructure.

#### Possible contract

```ts
interface FederationResolver {
    resolve(entityId: string): Promise<FederationEntity>;

    resolveTrustChain(
        entityId: string,
        trustAnchors: string[],
    ): Promise<FederationTrustChain>;
}
```

#### Acceptance criteria

Trust evaluation no longer performs federation HTTP retrieval directly.

---

## Phase 5 — Verification

### Task 14 — Refactor OID4VP into explicit application use cases

#### Goal

Apply the same application boundaries to verification.

#### Candidate use cases

```text
CreatePresentationRequest
RetrievePresentationRequest
ProcessPresentationResponse
ValidatePresentation
ResolvePresentedCredentials
EvaluatePresentationTrust
PublishPresentationResult
```

#### Acceptance criteria

Core verification flows can be tested without HTTP or TypeORM.

---

### Task 15 — Introduce presented credential format abstractions

#### Goal

Keep SD-JWT VC and mdoc verification details out of OID4VP orchestration.

#### Possible normalized result

```ts
interface PresentedCredential {
    format: string;
    claims: Record<string, unknown>;
    issuer: CredentialIssuerIdentity;
    holderBinding?: HolderBinding;
    status?: CredentialStatus;
    raw?: unknown;
}
```

Derive the final model from actual needs.

#### Target

```text
CredentialVerifierFormat
      ├─ SdJwtVcVerifier
      └─ MdocVerifier
```

Each format handles its own:

- parsing
- cryptographic verification
- holder/device binding
- format-specific validation
- claim extraction

#### Acceptance criteria

Adding another presentation format does not require rewriting the OID4VP orchestration flow.

---

### Task 16 — Align issuance and verification credential abstractions

#### Goal

Create a coherent format architecture across issuer and verifier.

Evaluate whether to use:

```text
CredentialFormat
  issue()
  verify()
```

or separate:

```text
CredentialIssuerFormat
CredentialVerifierFormat
```

Prefer separate contracts if responsibilities diverge significantly.

#### Acceptance criteria

SD-JWT VC and mdoc follow the same architectural pattern without artificial coupling.

---

## Phase 6 — Persistence and application boundaries

### Task 17 — Introduce repository ports for configuration aggregates

#### Goal

Remove direct TypeORM access from configuration application services.

#### Candidates

```text
CredentialConfigurationRepository
IssuanceConfigurationRepository
PresentationConfigurationRepository
WebhookConfigurationRepository
AttributeProviderConfigurationRepository
StatusListConfigurationRepository
TenantRepository
RegistrarConfigurationRepository
```

Migrate incrementally.

Do not create a generic `Repository<T>` abstraction.

#### Acceptance criteria

Migrated application services do not depend directly on TypeORM.

---

### Task 18 — Separate persistence entities from application models

#### Goal

Prevent persistence schema from defining application APIs.

Map where useful:

```text
TypeORM entity <-> application/domain model
```

Prioritize areas where entities currently leak through ports or public service APIs.

Do not duplicate models where there is no architectural benefit.

#### Acceptance criteria

Database representation changes do not automatically force application-port changes.

---

### Task 19 — Improve the client-provider abstraction

#### Goal

Retain the useful existing adapter pattern while removing infrastructure leakage.

Current concept:

```text
ClientsProvider
  ├─ InternalClientsProvider
  └─ KeycloakClientsProvider
```

Consider a more domain-oriented name such as:

```text
ClientRegistry
ClientIdentityProvider
```

Do not expose `ClientEntity` in the application-facing contract.

#### Acceptance criteria

Keycloak and TypeORM implementation details remain inside adapters.

---

### Task 20 — Replace widespread ConfigService usage with typed capability settings

#### Goal

Reduce direct framework configuration coupling.

#### Examples

```ts
interface SessionSettings {
    cleanupIntervalMs: number;
    retentionPeriodMs: number;
}

interface Oid4vciSettings {
    publicUrl: string;
}
```

Group settings by capability.

Do not create one abstraction per environment variable.

#### Acceptance criteria

Important application services no longer inject `ConfigService`.

---

### Task 21 — Formalize NestJS modules as composition roots

#### Goal

Make adapter selection explicit.

#### Example

```ts
{
    provide: SESSION_REPOSITORY,
    useClass: TypeOrmSessionRepository,
}
```

Apply the same pattern to:

```text
CredentialClaimsProvider
FederationResolver
CredentialIssuerFormat
CredentialVerifierFormat
```

#### Acceptance criteria

Application code never instantiates or selects infrastructure implementations directly.

---

### Task 22 — Introduce application/domain errors

#### Goal

Remove NestJS HTTP exceptions from application/domain code.

#### Examples

```text
SessionNotFound
UnknownCredentialConfiguration
UnsupportedCredentialFormat
InvalidCredentialProof
CredentialTrustValidationFailed
InvalidPresentation
```

Controllers/protocol adapters map these to transport/protocol errors.

#### Acceptance criteria

Application/domain code contains no NestJS HTTP exception dependencies.

---

## Phase 7 — Architecture quality

### Task 23 — Add reusable adapter contract tests

#### Goal

Guarantee equivalent behaviour across adapters.

#### Targets

```text
FileStorage
  ├─ Local
  └─ S3

KmsAdapter
  ├─ DB
  ├─ Vault
  ├─ AWS KMS
  ├─ CSC
  ├─ HTTP
  └─ PKCS#11

CredentialIssuerFormat
  ├─ SD-JWT VC
  └─ mdoc

CredentialVerifierFormat
  ├─ SD-JWT VC
  └─ mdoc

SessionRepository
  └─ TypeORM

ClientRegistry
  ├─ Internal
  └─ Keycloak
```

#### Acceptance criteria

Every interchangeable adapter implementation can be run against a shared contract suite where practical.

---

### Task 24 — Add pure application tests for critical flows

#### Goal

Make important business/protocol workflows testable without NestJS infrastructure.

#### Example

```ts
const useCase = new ProcessCredentialRequest(
    fakeSessions,
    fakeClaimsProvider,
    fakeCredentialFormats,
    fakeTrustEvaluator,
);
```

No database, HTTP server, Docker, or Nest TestingModule should be required for these tests.

#### Priority flows

- credential issuance
- deferred issuance
- claims resolution
- presentation verification
- trust evaluation
- session state transitions

#### Acceptance criteria

Most branching business logic is covered by cheap application-level tests.

---

### Task 25 — Perform a final backend dependency audit

#### Goal

Identify remaining infrastructure leakage.

Search application code for direct imports of:

```text
typeorm
@nestjs/typeorm
express
@nestjs/axios
S3Client
KeycloakAdminClient
Vault clients
node:fs
```

Classify each occurrence as:

```text
valid adapter usage
valid composition/bootstrap usage
architectural violation
```

Refactor violations.

#### Acceptance criteria

No unexplained dependency-direction violations remain.

---

## Recommended execution order

1. Review/adopt Task 1 and define incremental enforcement in Task 2.
2. Take one session operation through Tasks 3–4, including its models (18), settings (20), wiring (21), errors (22), and tests (23–24), then migrate remaining session operations in bounded slices.
3. Extract one OID4VCI flow through Tasks 5–6. Combine Tasks 7–9 for the first format boundary and Tasks 10–11 for claims/notification boundaries where appropriate; do not create temporary duplicate abstractions just to follow numbering.
4. Complete trust boundaries (12–13), then verification (14–16), reusing the same testing and composition approach.
5. Address remaining configuration/client-provider boundaries (17–19) and audit settings, composition, and errors (20–22).
6. Audit contract/application coverage (23–24) and remaining dependency violations (25).

Work in bounded slices under the user’s requested scope. A request may authorize multiple tasks; the backlog itself is not authorization to start implementation.

# Desired end state

EUDIPLO remains a modular monolith with explicit, enforceable boundaries.

```text
                           EUDIPLO
                              │
          ┌───────────────────┼────────────────────┐
          │                   │                    │
        Issuer              Verifier             Admin
          │                   │                    │
     inbound adapters     inbound adapters     inbound adapters
          │                   │                    │
          └──────────────── application ───────────┘
                              │
                    domain / protocol logic
                              │
                           ports
                              │
       ┌──────────────┬───────┼────────┬───────────────┐
       │              │       │        │               │
    Storage        Database   KMS    Trust        Claims provider
       │              │       │        │               │
   Local/S3        TypeORM   AWS/    LoTE/           HTTP/
                           Vault/CSC Federation       custom
```

Credential formats form a separate extensibility boundary:

```text
Issuance:
OID4VCI
   ↓
CredentialIssuerFormat
   ├─ SD-JWT VC
   └─ mdoc

Verification:
OID4VP
   ↓
CredentialVerifierFormat
   ├─ SD-JWT VC
   └─ mdoc
```

The objective is not maximum abstraction.

The objective is that protocol orchestration, credential semantics, and EUDIPLO application behaviour remain stable when infrastructure or supported credential formats change.
