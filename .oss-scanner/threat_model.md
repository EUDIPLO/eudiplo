# EUDIPLO threat model

Read by Anthropic's OSS Scanner before it analyses the repository. The
maintained description of the security model is
`apps/docs/docs/concepts/security-model.md`; where the two differ, that page
and the code are right.

## What this project does and where untrusted input enters

EUDIPLO is middleware between an organization's backend and EUDI Wallets. One
NestJS service (`apps/backend`) issues credentials over OpenID4VCI, verifies
presentations over OpenID4VP and the ISO 18013-7 Digital Credentials API, and
hosts status lists and trust lists. It serves several tenants from one
database. An Angular web client (`apps/client`), a CLI (`apps/cli`) and a
TypeScript SDK (`packages/eudiplo-sdk-core`) use its management API.

Four kinds of callers exist, with decreasing trust:

1. **Anyone on the internet, including wallets.** The protocol endpoints are
   public by design and take no bearer token of an API client:
   `/.well-known/...` (issuer, authorization server and key metadata),
   `/issuers/{tenantId}/...` (PAR, authorization, token, nonce, credential,
   deferred credential, notification, chained and interactive authorization,
   credential metadata, federation entity configuration, status lists, trust
   lists), `/presentations/{sessionId}/oid4vp`,
   `/presentations/{walletNonce}/iso-18013-7` and `/verifiers/{tenantId}/oidc`.
   One route in that tree is not public:
   `/issuers/{tenantId}/authorize/interactive/complete-web-auth/{authSession}`
   needs the `issuance:offer` role. Also reachable without a token:
   `GET /storage/{key}` (credential images and logos), the token endpoint
   `/api/oauth2/...`, `/health`, `GET /` and the OpenAPI pages at `/docs` and
   `/api/docs`. The controller routes outside `/api` are listed in
   `GLOBAL_PREFIX_EXCLUSIONS` in `apps/backend/src/main.helpers.ts`. Under
   `/api`, a route needs a token when it has `@Secured` or
   `@UseGuards(JwtAuthGuard)`; `/api/version`, `/api/frontend-config` and
   `/api/auth/me` need a token but no role.
   Everything a wallet sends is hostile: request objects,
   proofs, DPoP proofs, wallet and key attestations, encrypted requests and
   responses (JWE, HPKE), SD-JWT VC and mdoc presentations, key binding JWTs,
   `x5c` chains and transaction data.
2. **Remote servers that EUDIPLO fetches from.** Trust lists (ETSI TS 119 602
   LoTE as JWT, ETSI TS 119 612 Trusted Lists as XML), token status lists,
   CRLs, OpenID Federation entity configurations and subordinate statements,
   issuer and schema metadata, external and upstream authorization servers,
   webhooks, attribute providers and the EUDI Hub. Their answers are hostile,
   and so is every URL that a tenant configures or that a credential or
   certificate names.
3. **API clients and users of a tenant.** They call the management API under
   `/api` with an OAuth 2.0 bearer token that names one tenant and a set of
   roles (`apps/backend/src/auth/roles/role.enum.ts`). A client of one tenant
   is hostile towards every other tenant, and a client with few roles is
   hostile towards the rest of its own tenant.
4. **The platform operator.** Holds `tenants:manage`, the environment
   variables, the database, the configuration folder and the KMS. Trusted.

## Components that matter most / least

Most important, in this order:

- **Tenant isolation.** Every entity carries a `tenantId`. A token of tenant A
  must never read, change, sign with or infer the existence of data of tenant
  B: sessions, credentials, key chains, configurations, audit log, files,
  caches. Check ids taken from the URL or the body, not only list endpoints.
- **Authentication and roles** (`apps/backend/src/auth`): the built-in OAuth
  server at `/api/oauth2/token`, the external OIDC provider and Keycloak
  adapters, the `@Secured` decorator and its guards, the rules for granting
  roles, client secret handling and token revocation. A role must not reach
  what the role table in `apps/docs/docs/reference/roles.md` does not give it.
- **Private key material and secrets.** Private keys of `db` key chains, KMS
  provider credentials, client secrets, webhook and attribute provider API
  keys, upstream client secrets, the EUDI Hub portal token. They must not
  appear in API answers, configuration bundle exports, logs, audit log entries
  or error messages, except through the routes documented for `tenant:admin`
  and `tenants:manage`: the two key export endpoints and the KMS provider
  configuration. Encryption at rest is in
  `apps/backend/src/platform/data-encryption` and `apps/backend/src/crypto`.
- **Issuance** (`apps/backend/src/issuer`): anything that lets a wallet get a
  credential it is not entitled to, get it twice, bind it to a key it does not
  hold, or skip a required step: pre-authorized and authorization codes, PKCE,
  DPoP, `tx_code`, nonces, key proofs, wallet and key attestation, refresh
  tokens, deferred issuance, notifications, session binding.
- **Verification** (`apps/backend/src/verifier`, `apps/backend/src/trust`):
  anything that makes EUDIPLO report a presentation as valid when it is not:
  signature, issuer trust against trust lists or federation, certificate path
  and validity, status and revocation, key binding, nonce and audience,
  session binding (OID4VP section 13.3), DCQL matching, transaction data,
  response decryption, replay of a response in another session or tenant.
- **Outbound requests.** The outbound URL policy against server-side request
  forgery (`OUTBOUND_URL_*`), its redirect and DNS rebinding handling, and
  where an API key or token is sent. Look for fetches that do not go through
  the policy.
- **Parsers of hostile input.** JWT, JWE, SD-JWT, CBOR/COSE/mdoc, X.509 and
  ASN.1, XML and XAdES (`@xmldom/xmldom`, `xadesjs`, `xpath`), compressed
  status lists, uploaded files (`apps/backend/src/storage`), and configuration
  bundles and tenant folders (`apps/backend/src/platform/config-import`,
  `config-portability`, `packages/eudiplo-config-format`). Look for crashes of
  the process, unbounded memory or CPU, path traversal, prototype pollution,
  XML external entities and regular expressions with catastrophic backtracking.
- **Hosted status lists and trust lists.** Changing a credential's status or a
  trust list entry without the role for it, or serving a list signed with the
  wrong key chain.

Less important, still in scope:

- `apps/client`: cross-site scripting and token theft matter, because the
  client holds a management token. Layout and usability do not.
- `apps/cli` and `packages/eudiplo-sdk-core`: they run with the operator's or
  integrator's rights. In scope when hostile server answers or hostile
  configuration files make them write outside the project folder, run
  commands or leak secrets.
- `deployment/`, `docker-compose.yml`, `Dockerfile`, `monitor/`: examples and
  release images. Report defaults that are insecure without the documentation
  saying so.

Out of scope:

- `apps/docs`, `scripts/load-test`, `.devcontainer`, `.github` and `tmp/`.
- The keys, certificates and secrets in `assets/config/demo`,
  `assets/config/playground`, `apps/backend/test` and `apps/client/e2e`. They
  are public test fixtures.
- A vulnerable version of a dependency without a path in EUDIPLO that reaches
  the vulnerable code. Dependabot already reports those. A
  defect in `@owf/*`, `@openid4vc/*` or `@sd-jwt/*` that is reachable through
  EUDIPLO is in scope; say which package holds the root cause.
- Conformance gaps without a security effect.

## How to exercise it

The image has Node.js, pnpm, all dependencies, the built backend, CLI, SDK and
web client, and Chromium for Playwright. SQLite is the database. There is no
container runtime, so the PostgreSQL, Vault and S3 suites are skipped
(`E2E_SKIP_CONTAINERS=true` is set). Port 3000 must be free before an E2E run.

```sh
cd /src

# Backend unit tests (*.spec.ts under apps/backend, mostly in src/), all or one file
pnpm --filter @eudiplo/backend exec vitest run
pnpm --filter @eudiplo/backend exec vitest run src/trust/x509-validation.service.spec.ts

# Backend E2E: starts the assembled application on port 3000 and drives it
# over HTTP. One suite at a time; the whole set takes long on two CPUs.
pnpm --filter @eudiplo/backend exec vitest run --config ./test/vitest.config.ts test/auth.e2e-spec.ts

# A running backend with the demo tenant, a fresh SQLite database and the
# client id and secret "root" (http://127.0.0.1:3000, OpenAPI at /api/docs-json)
node apps/client/e2e/support/start-backend.mjs &

# The built web client on http://127.0.0.1:4200, next to the backend above
node apps/client/e2e/support/serve-dist.mjs &

# Client browser suites (Playwright, Chromium). They start their own backend
# and client, so stop the two servers above first. Use one worker: with more,
# timing-sensitive tests fail on two CPUs.
cd /src/apps/client
E2E_USE_BUILD=true pnpm exec playwright test e2e/login.spec.ts --workers=1 --reporter=line
```

After a change to the backend source run `pnpm --filter @eudiplo/backend build`
before starting it again. The unit and E2E tests compile the backend source
themselves. After a change to `packages/eudiplo-config-format` run
`pnpm --filter @eudiplo/config-format build` first, before the tests as well
as before a backend build.

The E2E helpers in `apps/backend/test/utils.ts`, `utils-mdoc.ts` and
`apps/backend/test/shared` build wallets, proofs, attestations and
presentations; reuse them for a reproducer. Suites are grouped by area under
`apps/backend/test/` (`issuance/`, `presentation/`, `trust-list/`, `auth/`,
`key/`, `config-portability/`, ...). A reproducer is best written as a new
`*.e2e-spec.ts` or `*.spec.ts` that fails before the fix.

Both `OUTBOUND_URL_ALLOW_HTTP` and `OUTBOUND_URL_ALLOW_PRIVATE_NETWORK` are set
in the E2E configuration and by `start-backend.mjs`, because the fixtures are
served from localhost; `start-backend.mjs` sets them whatever the caller's
environment says. Neither sets `NODE_ENV=production`, so both run with the
non-production behavior listed at the end of this file. To test the outbound
URL policy or the production behavior, start the built backend yourself from
an empty folder:

```sh
mkdir -p /tmp/eudiplo && cd /tmp/eudiplo
NODE_ENV=production PUBLIC_URL=http://127.0.0.1:3000 \
  MASTER_SECRET=scanner-master-secret-with-32-characters \
  AUTH_CLIENT_ID=root AUTH_CLIENT_SECRET=root \
  FOLDER=/tmp/eudiplo/data CONFIG_FOLDER=/tmp/eudiplo/config \
  node /src/apps/backend/dist/main.js &
```

## How you rate severity

Rate for a production deployment that follows
`apps/docs/docs/operate/production-checklist.md`: HTTPS, real secrets,
`NODE_ENV=production`, no `OUTBOUND_URL_ALLOW_*` flag, and PostgreSQL or, for
a single small instance, SQLite.

**Critical**

- Without a token, or as a wallet: reading or changing data behind the
  management API, running code, reading private keys or secrets.
- Crossing a tenant boundary with a token of another tenant, for reading or
  writing.
- Getting a credential issued without the authorization the issuance
  configuration requires, or with claims the wallet chose.
- A forged, replayed, revoked or untrusted presentation that EUDIPLO reports
  as valid in the default configuration.
- Obtaining a signature from a tenant's key chain, or its private key, without
  the role for it.

**High**

- Raising one's own roles inside a tenant, or acting on a client or user with
  more rights.
- Server-side request forgery that reaches internal addresses or reads the
  answer, from a tenant role or from a wallet.
- Bypass of a single protection that the documentation promises (DPoP, PKCE,
  wallet or key attestation, nonce or code single use, status check,
  certificate validity) when another layer still limits the damage; critical
  when it alone leads to one of the outcomes above.
- One unauthenticated request, or a few, that stops the process or makes it
  unusable for all tenants.
- Secrets or personal data of credential holders in logs, the audit log or
  API answers for a caller who must not see them.
- Stored cross-site scripting in the web client that a lower role or a wallet
  can plant for an administrator.

**Medium**

- Denial of service that needs a tenant token, sustained traffic or large
  uploads, or that affects one tenant or one session only.
- Blind server-side request forgery limited to public addresses, open
  redirects, cross-site scripting that needs unlikely interaction.
- Disclosure that data of another tenant exists (ids, names, counts) without
  its content.
- Missing audit log entries for changes the documentation says are audited.

**Low**

- Hardening without a demonstrated attack, issues that need the operator's
  rights, verbose errors without secrets, and findings limited to the CLI
  with files the operator wrote.

Say in every report which caller from the list above the attack starts from,
which configuration it needs, and whether that configuration is the default.

## Anything to leave alone

These are documented decisions, not findings:

- `tenants:manage` reaches every tenant. `tenant:admin` and `tenants:manage`
  can export the private keys of `db` key chains and read the KMS provider
  configuration with its credentials.
- The protocol endpoints are public. Report a missing protocol protection,
  not the missing bearer token.
- `MASTER_SECRET`, `AUTH_CLIENT_SECRET` and other values from `.env.example`,
  the dev container and the test configuration are placeholders.
- `OUTBOUND_URL_ALLOW_HTTP` and `OUTBOUND_URL_ALLOW_PRIVATE_NETWORK` switch
  the outbound URL policy off on purpose. Lists and keys on EUDIPLO's own
  `PUBLIC_URL` or `INTERNAL_URL` origin skip the policy, and CRL distribution
  points may use plain HTTP.
- KMS providers are called without the outbound URL policy, including those
  of a tenant's KMS configuration, which `tenant:admin` can set. That such a
  call can go to an internal address is documented. Do report what goes
  beyond it: a tenant that reads the answer of an internal service, or that
  obtains secrets, KMS configuration or credentials of the instance or of
  another tenant.
- Webhook requests are not signed; they carry an optional API key.
- `DB_SYNCHRONIZE=true` is a development setting.
- By default the private keys of `db` key chains are stored in the database,
  encrypted with a key derived from `MASTER_SECRET`. This is allowed in
  production; an external KMS and an external key source are optional.
- Without `NODE_ENV=production`, EUDIPLO skips TLS certificate checks when it
  fetches status lists and trust lists and returns internal error messages to
  API callers. The release image sets `NODE_ENV=production`.
- External authorization servers cannot enforce wallet attestation through
  EUDIPLO.
