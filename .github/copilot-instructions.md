# Copilot Instructions for EUDIPLO

## Project Architecture
- **Monorepo**: Contains multiple apps (backend, client, webhook) and shared packages.
- **Backend**: [apps/backend](../apps/backend) — NestJS API server, main business logic, protocol abstraction.
- **Client**: [apps/client](../apps/client) — Angular web UI for managing credentials, keys, and sessions.
- **Webhook**: [apps/webhook](../apps/webhook) — Cloudflare Worker webhook simulator.
- **Packages**: [packages/eudiplo-sdk-core](../packages/eudiplo-sdk-core) — Shared SDK core library.
- **Deployment**: [deployment/](../deployment) — Docker Compose configs for minimal/full setups. See [deployment/README.md](../deployment/README.md).
- **Monitoring**: [monitor/](../monitor) — OpenTelemetry Collector, Prometheus, Tempo, Loki & Grafana for observability.

## Backend Architecture Direction
- Follow the [target backend architecture](../apps/docs/docs/architecture/backend-architecture.md) and [backend-specific instructions](instructions/backend-architecture.instructions.md) for new or explicitly migrated code.
- Keep capability ownership; application use cases depend on domain models and application-owned ports, with infrastructure implementing those ports and NestJS modules wiring them.
- Keep Express, TypeORM, direct HTTP clients, infrastructure SDKs, and HTTP exceptions outside migrated application/domain boundaries. Prefer meaningful capability ports over generic library wrappers.
- The [refactoring plan](../apps/docs/docs/architecture/refactoring-plan.md) tracks status, open findings and next slices. Execute only the task or slice requested by the user; do not automatically start or continue it.
- Internal refactors may update all affected callers within the selected scope. Preserve external protocol/API/configuration behavior unless a change is explicitly requested.

## Developer Workflows
- **Install dependencies**: `pnpm install` (root)
- **Build all**: `pnpm build`
- **Start backend**: `pnpm --filter @eudiplo/backend dev` or use Docker Compose
- **Start client**: `pnpm --filter @eudiplo/client start`
- **Run all via Docker Compose**: `docker compose up -d` (see [deployment/README.md](../deployment/README.md))
- **Testing**: Use `pnpm test` or framework-specific commands in each app
- **Generate API types**: `pnpm run gen:api` (from root)

## Patterns & Conventions
- **API Design**: RESTful, protocol-agnostic endpoints. See [apps/backend/src](../apps/backend/src).
- **NestJS Modules**: Each feature has its own module. Folder layout, error mapping and DI wiring follow "Feature folder shape" in the [backend architecture](../apps/docs/docs/architecture/backend-architecture.md#feature-folder-shape): protocol and trust code uses `application/`, `domain/`, `ports/` and `adapters/`; administrative CRUD may stay a service with a TypeORM repository. Common subfolders:
  - `dto/` — Data Transfer Objects (request/response classes)
  - `entities/` — Database entities (TypeORM)
  - Application and domain errors are plain `Error` subclasses next to the use case or in `domain/`; missing resources extend `NotFoundError` (`shared/domain/not-found-error.ts`)
- **DTOs**: Always place DTOs in a `dto/` folder within the module. Never define DTOs inline in controllers or services. This keeps controllers and services clean and focused on their responsibilities.
- **Credential Configs**: JSON-based, managed via client UI and backend API.
- **Key Management**: Pluggable, supports filesystem and cloud KMS (see backend config).
- **Session Management**: Real-time updates via polling in client.
- **Environment Variables**: Each app has its own `.env` or `example.env`.
- **Testing**: Use framework-native tools (Vitest for backend, Angular CLI for client).
- **Docs**: Main docs in [apps/docs](../apps/docs), with API docs via Swagger/OpenAPI.

## Code Style & Quality
- Follow `tsconfig.base.json` strict settings. Prefer ES2022+ features (async/await, optional chaining, class fields).
- Use **Dependency Injection** for production NestJS composition. Pure application/domain tests may construct classes directly with fake ports.
- Use **`@InjectRepository`** for TypeORM repositories in persistence adapters; keep TypeORM out of migrated application/domain code.
- Never return raw entities from controllers — always map to DTOs.
- Use **Zod** for input validation (primary validation library in this project).
- Prefer **Composition over Inheritance** for features and providers.

## Rules for Backend Code
- **Native ESM**: The backend uses `"type": "module"`. Keep `module` and `moduleResolution` set to `nodenext`.
- **Relative specifiers**: Every relative `import` and `export` specifier must end in `.js`, even in `.ts` source files, because the specifier targets the emitted JavaScript file.
- **ESM runtime paths**: Use `fileURLToPath(import.meta.url)` with `dirname()` for module-relative filesystem paths. Do not use `__dirname`, `__filename`, or implicit CommonJS `require()`.
- **Dependency interop**: Use each dependency's native ESM default or named export form. Verify deep imports use explicit exported `.js` paths where the package requires them.
- **Production startup**: Keep `start:prod` pointed at the explicit `dist/main.js` entry point.
- Create only the module, controllers, services/use cases, and folders that the capability needs. Keep application commands distinct from transport DTOs and persistence entities.
- Always add Swagger annotations (`@ApiTags`, `@ApiOperation`, `@ApiResponse`, `@ApiBody`) on all controller endpoints.
- For controller request boundaries, prefer Zod-backed DTOs via `createZodDto(...)` and keep schema definitions as the source of truth.
- Use the **Pino logger** (`nestjs-pino` / `PinoLogger`). For audit logging (compliance events persisted to DB), use `AuditLogService`.
- Translate external failures at adapter boundaries into meaningful application errors while preserving causes internally and avoiding sensitive response details.
- Application/domain errors must be transport-independent; map them to NestJS HTTP or protocol errors at inbound boundaries. Migrate existing exception behavior with characterization tests in the selected slice.
- When adding credential/protocol-related functions, follow existing abstractions in `packages/eudiplo-sdk-core`. Never duplicate protocol logic across modules.
- Protocol logic lives in feature modules: OID4VCI in `issuer/issuance/oid4vci/`, OID4VP in `verifier/oid4vp/`.

## Rules for Angular Client
- All forms must use **Reactive Forms** — never template-driven forms.
- API requests must use the **generated API client** from `@eudiplo/sdk-core` (`pnpm run gen:api`) — no inline HTTP URLs.
- Use **standalone components** unless a module is specifically required.
- Follow **Smart/Dumb component** pattern:
  - Smart components: orchestrate data and logic
  - Dumb components: only receive `@Input` / emit `@Output` (UI only)
- Store shared state in services with `BehaviorSubject` for state and `Observable` for consumption.
- Use Angular Material theme tokens or shared semantic CSS variables for UI colors instead of hard-coded color values, and define light/dark variants so both themes remain readable. Literal colors are appropriate for user-configured or data-driven branding values.

## Protocol Flow Rules (OID4VCI / OID4VP)
- **Credential Issuance**: Always validate Access Tokens and DPoP (if enabled) before issuing. Never hardcode client metadata; use resolved metadata from configuration.
- **Presentation Flows**: Use nonce endpoints and replay prevention correctly. Always verify Wallet Attestation before mapping user data (if `walletAttestationRequired` is configured).
- Follow existing flow patterns in the feature module — never duplicate protocol logic.

## Database & Migrations
- **Dual database support**: The backend supports both **SQLite** (default, local dev) and **PostgreSQL** (production). All migrations, queries, column types, and schema changes **must work on both databases**. Always consider type differences (e.g., `uuid` vs `varchar` for primary/foreign keys, `jsonb` vs `json`, `timestamp with time zone` vs `datetime`). Use the `DB_TYPE` env var or `queryRunner.connection.options.type` to branch when needed.
- Generate migrations using `pnpm --filter @eudiplo/backend migration:generate`. Never edit migrations manually unless absolutely necessary.
- Always use TypeORM query builder or repository methods — never create raw/dynamic SQL queries.
- When adding new DB columns: update entity → create migration → update DTOs → update API schemas.
- When adding foreign keys in migrations, ensure column types **exactly match** the referenced table's primary key type on both SQLite and PostgreSQL.

## Error Handling & Logging
- Use explicit application/domain error types for expected failures. NestJS `HttpException` belongs at HTTP/protocol boundaries, where status codes, response bodies, and headers are mapped.
- Use `PinoLogger` with context and correlation ID (if present). Never log secrets, tokens, private keys, or user PII.

## Security
- Always use **async key loaders** — never read keys synchronously.
- Primary algorithm: **ES256 (ECDSA P-256)**.
- Always validate `aud`, `iss`, `exp`, `nbf`, and schema compliance in token verification.
- Never log secrets, tokens, private keys, or user PII.

## Git & Monorepo
- Always use PNPM workspace syntax (`pnpm --filter @eudiplo/...`).
- New shared logic must go into `packages/`, not copied across apps.
- Backend unit/application tests are co-located with source as `*.spec.ts`; E2E tests live in `apps/backend/test/` as `*.e2e-spec.ts`. Add focused tests and incremental boundary coverage with each migrated slice.
- Use **conventional commits** (`feat:`, `fix:`, `docs:`, etc.). Semantic-release uses these to determine version bumps.
- **Breaking changes**: Add a `BREAKING CHANGE:` footer in the commit message body **and** fill in the "Breaking Changes" section of the PR description. The PR description is the primary source for generating migration guides — describe _what_ changed and _how to migrate_.
- When creating a PR that contains breaking changes, add the `breaking-change` label.
- Every commit must be cryptographically signed and include a DCO sign-off.
- Use `git commit -S -s` when creating commits, including amended commits.
- Use the existing Git signing configuration and configured user identity.
  Do not change the signing key, signing format, or signing program.
- If signing fails or requires 1Password authorization, report the error
  and let the user authorize it. Never bypass signing.

## Deployment Conventions
- Docker Compose files: root `docker-compose.yml` and `deployment/docker-compose/docker-compose.yml`.
- Kubernetes manifests in `deployment/k8s/` — always include readiness/liveness probes and resource requests/limits.
- Never hardcode secret values — use environment variables.
- When modifying deployment, update both Docker Compose and K8s manifests as applicable.

## Observability
- Telemetry (metrics, traces, logs) is handled via **OpenTelemetry** using `nestjs-otel` and the `@opentelemetry/sdk-node`.
- The OTel SDK is bootstrapped in `apps/backend/src/tracing.ts` **before** NestJS starts. All signals are exported via OTLP to an OpenTelemetry Collector.
- `OpenTelemetryModule` is registered globally in `CoreModule` — do not import it in feature modules.
- For custom metrics, inject `MetricService` from `nestjs-otel` in an adapter or legacy service (not in `application/` or `domain/`, where a metrics port is used instead) and use `getCounter()`, `getHistogram()`, or `getUpDownCounter()`. Never use `prom-client` directly.
- HTTP metrics and traces are auto-instrumented — no manual instrumentation needed for request/response tracking.
- Logs are auto-correlated with traces via `nestjs-pino` + the Pino OTel instrumentation (trace_id/span_id injected automatically).
- The monitoring stack (OTel Collector → Prometheus / Tempo / Loki → Grafana) lives in [monitor/](../monitor).

## Integration & External Dependencies
- **OID4VCI, OID4VP, SD-JWT VC**: Protocol support in backend.
- **Cloudflare Workers**: Used in [apps/webhook](../apps/webhook).
- **OpenTelemetry / Prometheus / Tempo / Loki / Grafana**: Monitoring via [monitor/](../monitor).

## Examples
- **Minimal local run**: `docker compose up -d` (from root)
- **Dev backend only**: `pnpm --filter @eudiplo/backend dev`
- **Dev client only**: `pnpm --filter @eudiplo/client start`
- **Monitor stack**: `cd monitor && docker-compose up -d`

## Key Files & Directories
- [apps/backend/](../apps/backend) — API, business logic, protocols
- [apps/client/](../apps/client) — Angular UI
- [deployment/](../deployment) — Docker configs
- [monitor/](../monitor) — Monitoring stack
- [apps/docs/](../apps/docs) — Documentation

## Boilerplate Reference

**NestJS module structure** (administrative CRUD; protocol/trust code adds `application/`, `domain/`, `ports/`, `adapters/` as described in the backend architecture):

```text
feature/
  dto/
  entities/
  feature.module.ts
  feature.controller.ts
  feature.service.ts
```

**Angular component structure:**

```text
feature/
  feature.component.ts
  feature.component.html
  feature.component.scss
```

---
For more, see [README.md](../README.md) and app-specific READMEs.
