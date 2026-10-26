// Canonical portable-config identity and migration implementation.
// The CLI bundles this module through assets:sync; do not maintain a second engine.
import {
    findUnsupportedClaimPatterns,
    sanitizeClaimFields,
} from "./claim-constraints.js";

export const CONFIG_FORMATS = {
    Tenant: { slug: "tenant", file: "TenantConfigFile", version: 4 },
    Client: { slug: "client", file: "ClientConfigFile", version: 2 },
    KmsConfig: { slug: "kms-config", file: "KmsConfigFile", version: 2 },
    KeyChain: { slug: "key-chain", file: "KeyChainConfigFile", version: 3 },
    KeyChainDefaults: {
        slug: "key-chain-defaults",
        file: "KeyChainDefaultsConfigFile",
        version: 1,
    },
    RegistrarConfig: {
        slug: "registrar-config",
        file: "RegistrarConfigFile",
        version: 2,
    },
    IssuanceConfig: {
        slug: "issuance-config",
        file: "IssuanceConfigFile",
        version: 5,
    },
    CredentialConfig: {
        slug: "credential-config",
        file: "CredentialConfigFile",
        version: 3,
    },
    PresentationConfig: {
        slug: "presentation-config",
        file: "PresentationConfigFile",
        version: 3,
    },
    AttributeProvider: {
        slug: "attribute-provider",
        file: "AttributeProviderConfigFile",
        version: 1,
    },
    WebhookEndpoint: {
        slug: "webhook-endpoint",
        file: "WebhookEndpointConfigFile",
        version: 1,
    },
    TrustList: { slug: "trust-list", file: "TrustListConfigFile", version: 1 },
    FederationTrustAnchor: {
        slug: "federation-trust-anchor",
        file: "FederationTrustAnchorConfigFile",
        version: 1,
    },
    StatusList: {
        slug: "status-list",
        file: "StatusListConfigFile",
        version: 1,
    },
} as const;
export type ConfigResourceKind = keyof typeof CONFIG_FORMATS;
export const CONFIG_RESOURCE_KINDS = Object.keys(
    CONFIG_FORMATS,
) as ConfigResourceKind[];
export const SCHEMA_BASE = "https://eudiplo.dev/schemas/";
interface ConfigMetadata {
    generation?: number;
    ownership?: "unmanaged" | "file-managed";
}
export interface ConfigFile<T = Record<string, unknown>> {
    $schema: string;
    metadata?: ConfigMetadata;
    spec: T;
}
/** Normalized internal document with kind derived from the schema URL. */
export interface ConfigDocument<T = Record<string, unknown>>
    extends ConfigFile<T> {
    kind: ConfigResourceKind;
    metadata: ConfigMetadata;
}
export interface SchemaConfigFile<T = Record<string, unknown>> {
    $schema: string;
    metadata?: ConfigMetadata;
    spec: T;
}
export const CONFIG_SINGLETON_IDS: Partial<Record<ConfigResourceKind, string>> =
    {
        Tenant: "tenant",
        KmsConfig: "kms",
        RegistrarConfig: "registrar",
        IssuanceConfig: "issuance",
        KeyChainDefaults: "defaults",
    };
/** Resolve identity without copying it into metadata. Singletons have no data ID. */
export function resourceId(input: ConfigFile<unknown>): string {
    const { kind } = resolveConfigIdentity(input);
    const singleton = CONFIG_SINGLETON_IDS[kind];
    if (singleton) return singleton;
    const spec = input.spec as Record<string, unknown>;
    const field = kind === "Client" ? "clientId" : "id";
    const id = spec?.[field];
    if (typeof id !== "string" || !id.trim())
        throw new Error(`Configuration spec.${field} is required`);
    return id;
}
/**
 * The format version a bare file (a spec without envelope) is read as: v1,
 * except a key chain with `type`, which KeyChain v2 added and which the bare
 * key chain export writes (v3 for usage type `federation`, which KeyChain v3
 * added), and a KMS configuration with a provider that sets
 * `algorithms` or `defaultAlgorithm`, which KmsConfig v2 added and which the
 * tenant `kms.json` is saved as, a registrar configuration with
 * `relyingPartyContact`, which RegistrarConfig v2 added, and a tenant
 * `info.json` with `defaultAccessKeyChainId`, which TenantConfig v2 added, or
 * with `defaultKeyChains`, which TenantConfig v3 replaced it with (TenantConfig
 * v4 moved it to `key-chain-defaults.json`).
 */
export function bareFileVersion(
    kind: ConfigResourceKind,
    spec: Record<string, unknown>,
): number {
    if (kind === "KeyChain") {
        if (spec.usageType === "federation") return 3;
        return "type" in spec ? 2 : 1;
    }
    if (kind === "RegistrarConfig")
        return "relyingPartyContact" in spec ? 2 : 1;
    if (kind === "Tenant") {
        if ("defaultKeyChains" in spec) return 3;
        return "defaultAccessKeyChainId" in spec ? 2 : 1;
    }
    if (kind === "KmsConfig") {
        const providers = Array.isArray(spec.providers) ? spec.providers : [];
        return providers.some(
            (provider) =>
                typeof provider === "object" &&
                provider !== null &&
                ("algorithms" in provider || "defaultAlgorithm" in provider),
        )
            ? 2
            : 1;
    }
    return 1;
}
export interface ConfigMigrationIssue {
    severity: "warning" | "required-input" | "error";
    code: string;
    path: string;
    message: string;
    resource?: { kind: ConfigResourceKind; id: string };
}
export interface ConfigMigration {
    id: string;
    kind: ConfigResourceKind;
    from: number;
    to: number;
    migrate(
        spec: Record<string, unknown>,
        metadata: ConfigMetadata,
    ): {
        spec: Record<string, unknown>;
        metadata?: ConfigMetadata;
        issues?: ConfigMigrationIssue[];
    };
}
/**
 * IssuanceConfig v5 adds optional fields to `federation` for the published
 * entity configuration (entityTypes, authorityHints, entityKeyChainId,
 * entityConfigurationLifetimeSeconds, trustMarks, entityMetadata,
 * includeTrustChain) and requires a set `federation.entityId` to be an
 * Entity Identifier ({@link federationEntityIdProblem}; `http` is accepted
 * here, the backend decides by OUTBOUND_URL_ALLOW_HTTP). An empty value means
 * "not set". Another value is reported, not rewritten: only the operator
 * knows the URL of the entity.
 */
const issuanceConfigV4ToV5: ConfigMigration = {
    id: "issuance-config-v5-federation-entity",
    kind: "IssuanceConfig",
    from: 4,
    to: 5,
    migrate(spec) {
        const federation = spec.federation;
        const problem =
            object(federation) &&
            typeof federation.entityId === "string" &&
            federation.entityId !== ""
                ? federationEntityIdProblem(federation.entityId, {
                      allowHttp: true,
                  })
                : undefined;
        if (!problem) return { spec };
        return {
            spec,
            issues: [
                {
                    severity: "required-input",
                    code: "FEDERATION_ENTITY_ID_INVALID",
                    path: "/spec/federation/entityId",
                    message: `${problem}: set an https URL with a host and without query or fragment, usually <PUBLIC_URL>/issuers/<tenant>`,
                },
            ],
        };
    },
};

/**
 * Why `entityId` is no OpenID Federation Entity Identifier, or `undefined`
 * when it is one. OpenID Federation 1.0 Section 1.2: an https URL with a host
 * and without query or fragment. Credentials, whitespace and control
 * characters are refused as well, as a URL parser drops or changes them, so
 * the value would differ from the URL a resolver fetches. `http` passes only
 * with `allowHttp`, for local setups whose federation peers also allow it.
 */
export function federationEntityIdProblem(
    entityId: string,
    options: { allowHttp: boolean },
): string | undefined {
    const value = `federation.entityId '${JSON.stringify(entityId).slice(1, -1)}'`;
    // A URL parser drops an empty "?" or "#" and strips whitespace and
    // control characters, so look at the string itself.
    if (/[\s\u0000-\u001f\u007f]/.test(entityId)) {
        return `${value} must not contain whitespace or control characters`;
    }
    if (entityId.includes("?") || entityId.includes("#")) {
        return `${value} must not have a query or fragment`;
    }
    let url: URL;
    try {
        url = new URL(entityId);
    } catch {
        return `${value} is not a URL`;
    }
    if (url.protocol !== "https:" && !(options.allowHttp && url.protocol === "http:")) {
        return options.allowHttp
            ? `${value} must be an https or http URL`
            : `${value} must be an https URL (http only with OUTBOUND_URL_ALLOW_HTTP=true)`;
    }
    // Entity Identifiers are compared as strings, so a value the parser
    // rewrites ("HTTPS://", "https:///x", a backslash, an IDN host, a
    // default port) would name another entity than the URL it fetches.
    if (url.href !== entityId && url.href !== `${entityId}/`) {
        return `${value} must be written as the URL it stands for: ${url.href}`;
    }
    if (url.username || url.password) {
        return `${value} must not contain credentials`;
    }
    return undefined;
}

/**
 * PresentationConfig v2 replaces `registration_cert.body.provided_attestations`
 * with the registrar's `provides_attestations` (credential type identifiers).
 * v1 only accepted objects there, which the registrar API does not define and
 * ignored, so the field is dropped with a warning instead of being converted.
 */
const presentationConfigV1ToV2: ConfigMigration = {
    id: "presentation-config-v2-provides-attestations",
    kind: "PresentationConfig",
    from: 1,
    to: 2,
    migrate(spec) {
        const registrationCert = spec.registration_cert;
        if (
            !object(registrationCert) ||
            !object(registrationCert.body) ||
            !("provided_attestations" in registrationCert.body)
        ) {
            return { spec };
        }
        const { provided_attestations: _, ...body } = registrationCert.body;
        return {
            spec: { ...spec, registration_cert: { ...registrationCert, body } },
            issues: [
                {
                    severity: "warning",
                    code: "PROVIDED_ATTESTATIONS_REMOVED",
                    path: "/spec/registration_cert/body/provided_attestations",
                    message:
                        "provided_attestations is not part of the registrar API and was removed. Set provides_attestations to the credential type identifiers (SD-JWT VC vct or mdoc doctype) the issuer provides.",
                },
            ],
        };
    },
};

const tenantConfigV3ToV4: ConfigMigration = {
    id: "tenant-v4-key-chain-defaults",
    kind: "Tenant",
    from: 3,
    to: 4,
    // v4 moves the tenant's default key chains to their own resource,
    // KeyChainDefaults (key-chain-defaults.json). Only development builds of
    // 10.0 wrote defaultKeyChains, so the step drops it with a warning instead
    // of creating that document.
    migrate(spec) {
        if (!("defaultKeyChains" in spec)) return { spec };
        const { defaultKeyChains: _, ...rest } = spec;
        return {
            spec: rest,
            issues: [
                {
                    severity: "warning",
                    code: "DEFAULT_KEY_CHAINS_MOVED",
                    path: "/spec/defaultKeyChains",
                    message:
                        "defaultKeyChains is no longer part of the tenant settings and was removed. Set the default key chains in key-chain-defaults.json (KeyChainDefaults), for example { \"access\": \"<key chain ID>\" }.",
                },
            ],
        };
    },
};

/**
 * CredentialConfig v3 accepts only JSON Schema validation and annotation
 * keywords in claim field `constraints`. Other keys were stored unchecked
 * before; they are dropped with a warning. The strict claims validation at
 * issuance refused them already, and form renderers such as the Web Client's
 * formly read their own keys (`widget`) from the schema.
 *
 * v3 also matches claim patterns with RE2 ({@link findUnsupportedClaimPatterns}).
 * A pattern RE2 cannot run is reported, not rewritten: only the author knows
 * what it should accept.
 */
const credentialConfigV2ToV3: ConfigMigration = {
    id: "credential-config-v3-claim-constraint-keywords",
    kind: "CredentialConfig",
    from: 2,
    to: 3,
    migrate(spec) {
        if (!Array.isArray(spec.fields)) return { spec };
        const { fields, removed } = sanitizeClaimFields(
            spec.fields,
            "/spec/fields",
        );
        const issues: ConfigMigrationIssue[] = [
            ...removed.map((path) => ({
                severity: "warning" as const,
                code: "CLAIM_CONSTRAINT_KEYWORD_REMOVED",
                path,
                message:
                    "Removed: constraints accept only JSON Schema validation and annotation keywords.",
            })),
            ...findUnsupportedClaimPatterns(fields, "/spec/fields").map(
                ({ path, message }) => ({
                    severity: "required-input" as const,
                    code: "CLAIM_PATTERN_UNSUPPORTED",
                    path,
                    message,
                }),
            ),
        ];
        if (issues.length === 0) return { spec };
        return {
            spec: removed.length > 0 ? { ...spec, fields } : spec,
            issues,
        };
    },
};

// The first published format is v1. Register one step per later version.
const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [
    {
        id: "issuance-config-v2-offer-lifetime",
        kind: "IssuanceConfig",
        from: 1,
        to: 2,
        // v2 only adds the optional offerLifetimeSeconds: a v1 spec is a
        // valid v2 spec whose offers keep having no lifetime.
        migrate: (spec) => ({ spec }),
    },
    {
        id: "issuance-config-v3-trust-list-verifier-pem",
        kind: "IssuanceConfig",
        from: 2,
        to: 3,
        // v3 only adds the optional verifierKeyPem to wallet provider trust
        // list references: a v2 spec is a valid v3 spec.
        migrate: (spec) => ({ spec }),
    },
    {
        id: "issuance-config-v4-wallet-attestation-status-check-mode",
        kind: "IssuanceConfig",
        from: 3,
        to: 4,
        // v4 only adds the optional walletAttestationStatusCheckMode to the
        // issuance configuration and its authorization servers: a v3 spec is
        // a valid v4 spec.
        migrate: (spec) => ({ spec }),
    },
    issuanceConfigV4ToV5,
    {
        id: "client-v2-read-and-status-roles",
        kind: "Client",
        from: 1,
        to: 2,
        // v2 only adds the roles audit:read, sessions:read, credentials:status
        // and keys:manage: a v1 spec is a valid v2 spec.
        migrate: (spec) => ({ spec }),
    },
    {
        id: "kms-config-v2-algorithms",
        kind: "KmsConfig",
        from: 1,
        to: 2,
        // v2 only adds the optional provider fields algorithms and
        // defaultAlgorithm: a v1 spec is a valid v2 spec, whose providers keep
        // their default algorithms.
        migrate: (spec) => ({ spec }),
    },
    {
        id: "registrar-config-v2-relying-party-contact",
        kind: "RegistrarConfig",
        from: 1,
        to: 2,
        // v2 only adds the optional relyingPartyContact: a v1 spec is a
        // valid v2 spec, whose relying party is registered without contact
        // as before.
        migrate: (spec) => ({ spec }),
    },
    {
        id: "tenant-v2-default-access-key-chain",
        kind: "Tenant",
        from: 1,
        to: 2,
        // v2 only adds the optional defaultAccessKeyChainId: a v1 spec is a
        // valid v2 spec, whose tenant keeps picking its access key chain by
        // rule.
        migrate: (spec) => ({ spec }),
    },
    {
        id: "tenant-v3-default-key-chains",
        kind: "Tenant",
        from: 2,
        to: 3,
        // v3 keeps the tenant's default key chains in a map by usage type:
        // defaultAccessKeyChainId becomes defaultKeyChains.access.
        migrate: (spec) => {
            const { defaultAccessKeyChainId, ...rest } = spec;
            return {
                spec:
                    typeof defaultAccessKeyChainId === "string"
                        ? {
                              ...rest,
                              defaultKeyChains: {
                                  access: defaultAccessKeyChainId,
                              },
                          }
                        : rest,
            };
        },
    },
    tenantConfigV3ToV4,
    {
        id: "key-chain-v2-type",
        kind: "KeyChain",
        from: 1,
        to: 2,
        // v2 only adds the optional key chain `type`: a v1 spec is a valid v2
        // spec, imported as before.
        migrate: (spec) => ({ spec }),
    },
    {
        id: "key-chain-v3-federation-usage",
        kind: "KeyChain",
        from: 2,
        to: 3,
        // v3 only adds the usage type `federation`: a v2 spec is a valid v3
        // spec.
        migrate: (spec) => ({ spec }),
    },
    {
        id: "credential-config-v2-x509-trusted-authority",
        kind: "CredentialConfig",
        from: 1,
        to: 2,
        // v2 only adds the frameworkType `x509` to schemaMeta trusted
        // authorities, which schema metadata publishing already writes: a v1
        // spec is a valid v2 spec.
        migrate: (spec) => ({ spec }),
    },
    credentialConfigV2ToV3,
    presentationConfigV1ToV2,
    {
        id: "presentation-config-v3-typed-claim-values",
        kind: "PresentationConfig",
        from: 2,
        to: 3,
        // v3 accepts integer and boolean DCQL claim `values` besides strings
        // and requires them to be non-empty. A v2 spec with non-empty string
        // values is a valid v3 spec; an empty `values` array fails v3
        // validation, since it could never match a disclosed claim.
        migrate: (spec) => ({ spec }),
    },
];
export function schemaUrl(
    kind: ConfigResourceKind,
    version: number = CONFIG_FORMATS[kind].version,
): string {
    if (!Number.isSafeInteger(version) || version < 1)
        throw new Error("Invalid config version");
    return `${SCHEMA_BASE}v${version}/${CONFIG_FORMATS[kind].file}.schema.json`;
}
function object(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
export function isConfigDocument(value: unknown): value is ConfigFile {
    return object(value) && "$schema" in value;
}
export function resolveConfigIdentity(input: { $schema?: unknown }): {
    kind: ConfigResourceKind;
    version: number;
} {
    if (typeof input.$schema !== "string")
        throw new Error("$schema must be a canonical EUDIPLO schema URL");
    const match =
        /^https:\/\/eudiplo\.dev\/schemas\/v([1-9][0-9]*)\/([A-Za-z]+)\.schema\.json$/.exec(
            input.$schema,
        );
    const kind = CONFIG_RESOURCE_KINDS.find(
        (candidate) => CONFIG_FORMATS[candidate].file === match?.[2],
    );
    if (!match || !kind || !Number.isSafeInteger(Number(match[1])))
        throw new Error(`Unknown configuration schema: ${input.$schema}`);
    const identity = { kind, version: Number(match[1]) };
    if (identity.version > CONFIG_FORMATS[identity.kind].version)
        throw new Error(
            `${identity.kind} version ${identity.version} is newer than supported version ${CONFIG_FORMATS[identity.kind].version}`,
        );
    return identity;
}
export function normalizeDocument(input: unknown): ConfigDocument {
    if (!object(input))
        throw new Error("Invalid configuration document envelope");
    const { kind, version } = resolveConfigIdentity(input);
    if (
        Object.keys(input).some(
            (key) => !["$schema", "kind", "metadata", "spec"].includes(key),
        )
    )
        throw new Error("Unknown configuration envelope property");
    const metadata = input.metadata ?? {};
    if (!object(metadata) || !object(input.spec))
        throw new Error("An object spec and valid metadata are required");
    const unknownMetadataKeys = Object.keys(metadata).filter(
        (key) => !["generation", "ownership"].includes(key),
    );
    if (unknownMetadataKeys.length > 0)
        throw new Error(
            `Invalid configuration metadata: unsupported propert${unknownMetadataKeys.length === 1 ? "y" : "ies"} ${unknownMetadataKeys.join(", ")}`,
        );
    if (
        metadata.generation !== undefined &&
        (typeof metadata.generation !== "number" ||
            !Number.isSafeInteger(metadata.generation) ||
            metadata.generation < 1)
    )
        throw new Error(
            "Invalid configuration metadata: generation must be a positive integer",
        );
    if (
        metadata.ownership !== undefined &&
        !["unmanaged", "file-managed"].includes(String(metadata.ownership))
    )
        throw new Error(
            "Invalid configuration metadata: ownership must be unmanaged or file-managed",
        );
    const spec = structuredClone(input.spec);
    const canonicalMetadata = structuredClone(metadata);
    resourceId({ $schema: schemaUrl(kind, version), spec });
    if (input.kind !== undefined && input.kind !== kind)
        throw new Error("kind conflicts with $schema");
    return {
        $schema: schemaUrl(kind, version),
        kind,
        metadata: canonicalMetadata,
        spec,
    };
}
export function serializeDocument<T>(
    input: ConfigFile<T>,
): SchemaConfigFile<T> {
    const document = normalizeDocument(input);
    return {
        $schema: document.$schema!,
        ...(Object.keys(document.metadata).length
            ? { metadata: document.metadata }
            : {}),
        spec: document.spec as T,
    };
}
export type ConfigValidator = (
    document: ConfigDocument,
) => ConfigMigrationIssue[];
export function migrateDocument(
    input: unknown,
    validate: ConfigValidator,
    migrations: readonly ConfigMigration[] = CONFIG_MIGRATIONS,
    targetVersion?: number,
): {
    document: ConfigDocument;
    migrations: string[];
    issues: ConfigMigrationIssue[];
} {
    let document = normalizeDocument(input);
    const { kind, version: sourceVersion } = resolveConfigIdentity(document);
    const target = targetVersion ?? CONFIG_FORMATS[kind].version;
    if (!Number.isSafeInteger(target) || target < sourceVersion)
        throw new Error("Config downgrades are not supported");
    const issues = validate(document);
    const applied: string[] = [];
    if (issues.some((issue) => issue.severity !== "warning"))
        return { document, migrations: applied, issues };
    for (let version = sourceVersion; version < target; version++) {
        const candidates = migrations.filter(
            (step) => step.kind === kind && step.from === version,
        );
        const step = candidates[0];
        if (candidates.length !== 1 || step.to !== version + 1)
            throw new Error(
                `No unique migration registered for ${kind} v${version} to v${version + 1}`,
            );
        const result = step.migrate(
            structuredClone(document.spec),
            structuredClone(document.metadata),
        );
        issues.push(...(result.issues ?? []));
        if (issues.some((issue) => issue.severity !== "warning")) break;
        const candidate = {
            ...document,
            spec: result.spec,
            metadata: result.metadata ?? document.metadata,
            $schema: schemaUrl(kind, step.to),
        };
        issues.push(...validate(candidate));
        if (issues.some((issue) => issue.severity !== "warning")) break;
        document = candidate;
        applied.push(step.id);
    }
    return { document, migrations: applied, issues };
}
