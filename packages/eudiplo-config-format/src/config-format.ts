// Canonical portable-config identity and migration implementation.
// The CLI bundles this module through assets:sync; do not maintain a second engine.
export const CONFIG_FORMATS = {
    Tenant: { slug: "tenant", file: "TenantConfigFile", version: 1 },
    Client: { slug: "client", file: "ClientConfigFile", version: 1 },
    KmsConfig: { slug: "kms-config", file: "KmsConfigFile", version: 1 },
    KeyChain: { slug: "key-chain", file: "KeyChainConfigFile", version: 1 },
    RegistrarConfig: {
        slug: "registrar-config",
        file: "RegistrarConfigFile",
        version: 1,
    },
    IssuanceConfig: {
        slug: "issuance-config",
        file: "IssuanceConfigFile",
        version: 2,
    },
    CredentialConfig: {
        slug: "credential-config",
        file: "CredentialConfigFile",
        version: 1,
    },
    PresentationConfig: {
        slug: "presentation-config",
        file: "PresentationConfigFile",
        version: 1,
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
