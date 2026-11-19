# Architecture Diagram

This Archify view describes EUDIPLO as a protocol middleware runtime. It emphasizes deployable boundaries and trust relationships rather than implementation classes. The backend is one NestJS runtime that exposes both management APIs and wallet-facing OID4VCI and OID4VP endpoints.

## Application Architecture

<!-- mermaid-checked: no \n, no em-dash/en-dash, no {} in labels, subgraphs are id["label"], arrows are -->|"label"|, all subgraphs closed by end, ids unique -->
~~~mermaid
flowchart TD
    subgraph EudiploBoundary["EUDIPLO trusted runtime"]
        Client["Angular management client"]
        Api["NestJS backend API"]
        Issuer["Issuer middleware"]
        Verifier["Verifier middleware"]
        AuthServer["Authorization server middleware"]
        SessionDb[("Session and tenant database")]
        KeyMgmt["Key management and signing"]
        Attribute["Attribute provider gateway"]
        Webhooks["Webhook integration"]
        FileStore[("Configuration and file storage")]
    end
    subgraph ExternalBoundary["External trust boundary"]
        Wallet["EUDI wallet"]
        Identity["External identity providers"]
        Kms["External KMS or vault"]
        WebhookTargets["External webhook targets"]
        UpstreamAs["External authorization servers"]
    end

    Client -->|"management API and session polling"| Api
    Api -->|"routes management and protocol traffic"| Issuer
    Api -->|"routes management and protocol traffic"| Verifier
    Api -->|"authenticates operators and clients"| AuthServer
    Issuer -->|"creates offers and credentials"| Wallet
    Wallet -->|"credential requests and notifications"| Issuer
    Verifier -->|"authorization requests and VP responses"| Wallet
    Wallet -->|"verifiable presentations"| Verifier
    AuthServer -->|"token and metadata federation"| Identity
    AuthServer -.->|"optional chained flow"| UpstreamAs
    Issuer -->|"session state and tenant config"| SessionDb
    Verifier -->|"session state and outcomes"| SessionDb
    AuthServer -->|"authorization state"| SessionDb
    Issuer -->|"claims lookup"| Attribute
    Attribute -->|"identity attributes"| Identity
    Issuer -->|"signs credentials"| KeyMgmt
    Verifier -->|"verifies signatures and trust"| KeyMgmt
    KeyMgmt -.->|"external signing or key storage"| Kms
    Issuer -->|"claims and lifecycle events"| Webhooks
    Verifier -->|"presentation outcomes"| Webhooks
    Webhooks -->|"HTTP callbacks"| WebhookTargets
    Api -->|"config and files"| FileStore
~~~

### Technology Stack Summary

| Layer | Technology | Version | Purpose |
| --- | --- | --- | --- |
| Management UI | Angular and Angular Material | 22 | Tenant, credential, key, issuer, verifier, and session administration |
| Middleware API | NestJS on Express | 12 / 5 | Shared HTTP boundary for management and wallet-facing protocol routes |
| Credential protocols | OpenID4VCI and OpenID4VP libraries | 0.5.5 | Credential issuance, authorization, presentation requests, and responses |
| Persistence | TypeORM with SQLite or PostgreSQL | 1.1.1 | Stores tenants, configuration, sessions, outcomes, keys, and audit data |
| Key management | Pluggable KMS adapters | repository-defined | Signs and verifies without requiring private key material to leave the backend boundary |
| Webhook transport | Axios via Nest HTTP module | 1.20 | Calls configured attribute and application webhook endpoints |
| Observability | OpenTelemetry and Pino | 0.222 / 10 | Traces, metrics, logs, and request correlation |

### Data Storage and External Services

The backend persists protocol sessions and tenant configuration through TypeORM, using SQLite for local deployments or PostgreSQL for production. Files can use local storage or S3-compatible storage. Key material is abstracted behind database, Vault, AWS KMS, CSC, HTTP KMS, and PKCS11 adapters. Attribute providers and application webhooks are outbound HTTP integrations protected by URL policy checks. External OIDC providers such as Keycloak can own operator authentication and JWKS validation, while external authorization servers can participate in chained issuance flows.

### Key Architectural Decisions

- Wallet-facing protocol endpoints remain at the public root while management endpoints use the `/api` prefix, allowing standards-compliant OID4VCI and OID4VP URLs.
- Issuer, verifier, authorization-server, session, and key-management capabilities are composed as Nest modules in one backend process, with persistence and cryptographic services shared across flows.
- Trust-sensitive integrations are explicit: external identity, KMS, authorization-server, attribute-provider, webhook, and wallet edges are separated from the EUDIPLO runtime boundary.

## Component Relationships

<!-- mermaid-checked: no \n, no em-dash/en-dash, no {} in labels, subgraphs are id["label"], arrows are -->|"label"|, all subgraphs closed by end, ids unique -->
~~~mermaid
flowchart LR
    subgraph RuntimeLayer["EUDIPLO runtime"]
        cApi["Backend API"]
        cIssuer["Issuer"]
        cVerifier["Verifier"]
        cAs["Authorization server"]
        cSession["Session service"]
        cKeys["Key service"]
        cOutbound["Outbound integrations"]
    end
    subgraph DataLayer["Persistence"]
        cDb[("SQLite or PostgreSQL")]
        cFiles[("Local or S3 storage")]
    end
    subgraph TrustLayer["External trust boundary"]
        cWallet["EUDI wallet"]
        cIdp["OIDC identity provider"]
        cKms["External KMS"]
        cTarget["Webhook target"]
    end

    cApi -->|"delegates protocol traffic"| cIssuer
    cApi -->|"delegates presentation traffic"| cVerifier
    cApi -->|"authenticates API users"| cAs
    cIssuer -->|"uses"| cSession
    cVerifier -->|"uses"| cSession
    cAs -->|"uses"| cSession
    cIssuer -->|"signs"| cKeys
    cVerifier -->|"verifies"| cKeys
    cIssuer -->|"claims and notifications"| cOutbound
    cVerifier -->|"outcomes"| cOutbound
    cSession -->|"reads and writes"| cDb
    cApi -->|"reads and writes"| cFiles
    cKeys -.->|"optional remote signing"| cKms
    cAs -.->|"OIDC discovery and JWKS"| cIdp
    cIssuer -->|"issues to"| cWallet
    cVerifier -->|"requests and receives"| cWallet
    cOutbound -->|"HTTPS callbacks"| cTarget
~~~

### Component Inventory

| Component | Layer | Type | Responsibility |
| --- | --- | --- | --- |
| Angular management client | Presentation | Deployable web UI | Configures tenants, credentials, issuance, presentation, keys, sessions, and webhooks |
| Backend API | Runtime | NestJS application | Shared HTTP boundary for management and wallet-facing endpoints |
| Issuer middleware | Runtime | Protocol boundary | Implements OID4VCI offers, token and credential endpoints, deferred issuance, and notifications |
| Verifier middleware | Runtime | Protocol boundary | Creates presentation requests and consumes wallet presentation responses |
| Authorization server middleware | Runtime | OAuth and chaining boundary | Handles built-in authorization, OID4VP authorization-server mode, and external or chained servers |
| Session service | Runtime | State boundary | Correlates issuance, authorization, presentation, callbacks, and outcomes |
| Key service | Runtime | Cryptographic boundary | Resolves configured providers and signs or verifies protocol artifacts |
| Outbound integrations | Runtime | HTTP integration boundary | Calls attribute providers and configured webhook endpoints |
| SQLite or PostgreSQL | Data | Durable store | Persists sessions, tenant configuration, keys, audit records, and protocol resources |
| Local or S3 storage | Data | File store | Stores imported and portable configuration or other managed files |
| EUDI wallet | External | Protocol participant | Requests credentials and returns verifiable presentations |
| OIDC identity provider | External | Authentication authority | Supplies operator or client identity, tokens, and JWKS when external OIDC is enabled |
| External KMS | External | Key custody service | Performs remote key operations when a non-database KMS adapter is configured |
| Webhook target | External | Application integration | Supplies claims or receives issuance, presentation, and notification events |

## Source Evidence

| EUDIPLO component or boundary | Source evidence |
| --- | --- |
| Separate Angular and backend deployments | [docker-compose.yml](docker-compose.yml) and [apps/client/package.json](apps/client/package.json) |
| Backend composition and module boundaries | [apps/backend/src/app.module.ts](apps/backend/src/app.module.ts), [apps/backend/src/issuer/issuer.module.ts](apps/backend/src/issuer/issuer.module.ts), and [apps/backend/src/verifier/verifier.module.ts](apps/backend/src/verifier/verifier.module.ts) |
| Root and management route split | [apps/backend/src/main.ts](apps/backend/src/main.ts) |
| OID4VCI wallet-facing boundary | [apps/backend/src/issuer/issuance/oid4vci/oid4vci.controller.ts](apps/backend/src/issuer/issuance/oid4vci/oid4vci.controller.ts) |
| OID4VP wallet-facing boundary | [apps/backend/src/verifier/oid4vp/oid4vp.controller.ts](apps/backend/src/verifier/oid4vp/oid4vp.controller.ts) |
| Managed, external, and chained authorization servers | [apps/backend/src/issuer/issuance/oid4vci/authorization/authorization-servers/authorization-servers.service.ts](apps/backend/src/issuer/issuance/oid4vci/authorization/authorization-servers/authorization-servers.service.ts) |
| Session persistence and events | [apps/backend/src/session/session.module.ts](apps/backend/src/session/session.module.ts) |
| SQLite or PostgreSQL persistence | [apps/backend/src/database/database.module.ts](apps/backend/src/database/database.module.ts) |
| Pluggable key management | [apps/backend/src/crypto/key/key.module.ts](apps/backend/src/crypto/key/key.module.ts) and [apps/backend/src/crypto/key/kms/kms-provider.registry.ts](apps/backend/src/crypto/key/kms/kms-provider.registry.ts) |
| Attribute-provider outbound lookup | [apps/backend/src/issuer/configuration/attribute-provider/attribute-provider.service.ts](apps/backend/src/issuer/configuration/attribute-provider/attribute-provider.service.ts) |
| Webhook claims and notification callbacks | [apps/backend/src/webhook/webhook.service.ts](apps/backend/src/webhook/webhook.service.ts) |
| External OIDC and Keycloak integration | [apps/backend/src/auth/jwt.strategy.ts](apps/backend/src/auth/jwt.strategy.ts) and [.env.example](.env.example) |

## Guided Views

### OID4VCI issuance

<!-- mermaid-checked: no \n, no em-dash/en-dash, no {} in labels, subgraphs are id["label"], arrows are -->|"label"|, all subgraphs closed by end, ids unique -->
~~~mermaid
flowchart LR
    g1Client["Management client"] -->|"creates offer"| g1Api["Backend API"]
    g1Api -->|"creates session"| g1Session[("Session database")]
    g1Wallet["EUDI wallet"] -->|"retrieves offer"| g1Issuer["Issuer"]
    g1Issuer -->|"authorization and token"| g1As["Authorization server"]
    g1As -->|"optional identity"| g1Idp["External identity provider"]
    g1Wallet -->|"credential request"| g1Issuer
    g1Issuer -->|"claims"| g1Attr["Attribute provider"]
    g1Issuer -->|"signs credential"| g1Key["Key management"]
    g1Issuer -->|"credential response"| g1Wallet
    g1Issuer -->|"event"| g1Hook["Webhook target"]
    g1Issuer -->|"status and outcome"| g1Session
~~~

The issuer creates an offer and session, the wallet completes the configured authorization path, and the credential endpoint resolves claims, signs the credential, and returns an immediate or deferred response. This view is grounded by the OID4VCI controller, authorization-server service, session module, attribute-provider service, key registry, and webhook service listed above.

### OID4VP presentation

<!-- mermaid-checked: no \n, no em-dash/en-dash, no {} in labels, subgraphs are id["label"], arrows are -->|"label"|, all subgraphs closed by end, ids unique -->
~~~mermaid
flowchart LR
    g2Client["Management client"] -->|"creates presentation session"| g2Api["Backend API"]
    g2Api -->|"stores request state"| g2Session[("Session database")]
    g2Api -->|"creates request"| g2Verifier["Verifier"]
    g2Verifier -->|"signed request"| g2Wallet["EUDI wallet"]
    g2Wallet -->|"VP response"| g2Verifier
    g2Verifier -->|"verify signatures and trust"| g2Key["Key management"]
    g2Verifier -->|"store outcome"| g2Session
    g2Verifier -->|"claims or result"| g2Hook["Webhook target"]
~~~

The verifier creates a session-bound authorization request, the wallet returns a presentation, and the backend verifies and persists the result before notifying the relying application. The wallet-facing route is the OID4VP controller under the verifier module.

### Presentation during issuance

<!-- mermaid-checked: no \n, no em-dash/en-dash, no {} in labels, subgraphs are id["label"], arrows are -->|"label"|, all subgraphs closed by end, ids unique -->
~~~mermaid
flowchart LR
    g3Client["Management client"] -->|"starts issuance"| g3Issuer["Issuer"]
    g3Issuer -->|"selects authorization server"| g3As["Authorization server"]
    g3As -->|"starts OID4VP request"| g3Verifier["Verifier"]
    g3Verifier -->|"requests prior credential"| g3Wallet["EUDI wallet"]
    g3Wallet -->|"presentation response"| g3Verifier
    g3Verifier -->|"verified identity"| g3As
    g3As -->|"authorization result"| g3Issuer
    g3Issuer -->|"claims lookup"| g3Attr["Attribute provider"]
    g3Issuer -->|"signs new credential"| g3Key["Key management"]
    g3Issuer -->|"credential response"| g3Wallet
    g3Issuer -->|"shared transaction state"| g3Session[("Session database")]
~~~

This chained path uses the authorization-server middleware to invoke an OID4VP presentation before allowing issuance to continue. The authorization-server service explicitly supports an OID4VP-managed server backed by a presentation configuration, and the shared session, verifier, attribute-provider, and key-management boundaries carry the transaction through to credential issuance.
