/** A key chain that configurations of its tenant may name. */
export interface ReferencedKeyChain {
    tenantId: string;
    id: string;
}

/** Kinds of configuration that can name a key chain, in message order. */
export const KEY_CHAIN_REFERENCE_KINDS = [
    "Tenant",
    "IssuanceConfig",
    "CredentialConfig",
    "PresentationConfig",
    "StatusList",
    "TrustList",
] as const;

export type KeyChainReferenceKind = (typeof KEY_CHAIN_REFERENCE_KINDS)[number];

export function isKeyChainReferenceKind(
    kind: string,
): kind is KeyChainReferenceKind {
    return (KEY_CHAIN_REFERENCE_KINDS as readonly string[]).includes(kind);
}

/** A configuration of the key chain's tenant that names the key chain. */
export interface KeyChainReference {
    kind: KeyChainReferenceKind;
    /**
     * Configuration ID; absent for the tenant settings and the issuance
     * configuration, which a tenant has once.
     */
    id?: string;
    description?: string;
}

/** Kinds a tenant has once, whose references carry no ID. */
type SingletonKind = "Tenant" | "IssuanceConfig";

function isSingletonKind(kind: KeyChainReferenceKind): kind is SingletonKind {
    return kind === "Tenant" || kind === "IssuanceConfig";
}

/**
 * The ID a reference to the configuration carries: none for the tenant
 * settings and the issuance configuration, which a tenant has once.
 */
export function keyChainReferenceId(
    kind: KeyChainReferenceKind,
    id: string,
): string | undefined {
    return isSingletonKind(kind) ? undefined : id;
}

/**
 * True when a key chain ID field names the key chain. An empty or missing
 * value names none: the configuration then uses the tenant's default key
 * chain of the usage type, which a delete does not refuse.
 */
export function keyChainIdNamesKeyChain(
    keyChainId: unknown,
    keyChain: ReferencedKeyChain,
): boolean {
    return typeof keyChainId === "string" && keyChainId === keyChain.id;
}

/** Most configuration IDs of one kind the error message names. */
const NAMED_PER_KIND = 5;

const kindNames: Record<
    Exclude<KeyChainReferenceKind, SingletonKind>,
    { singular: string; plural: string }
> = {
    CredentialConfig: {
        singular: "credential config",
        plural: "credential configs",
    },
    PresentationConfig: {
        singular: "presentation config",
        plural: "presentation configs",
    },
    StatusList: { singular: "status list", plural: "status lists" },
    TrustList: { singular: "trust list", plural: "trust lists" },
};

function joinWithAnd(parts: string[]): string {
    return parts.length < 2
        ? (parts[0] ?? "")
        : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** Roles that read a kind of configuration, named for hidden references. */
export type KeyChainReferenceReadRoles = (
    kind: KeyChainReferenceKind,
) => readonly string[];

/** Names the IDs of one kind, or says which roles show them when they are hidden. */
function describeKind(
    kind: Exclude<KeyChainReferenceKind, SingletonKind>,
    references: KeyChainReference[],
    readRoles?: KeyChainReferenceReadRoles,
): string | undefined {
    const ofKind = references.filter((reference) => reference.kind === kind);
    if (ofKind.length === 0) return undefined;
    const { singular, plural } = kindNames[kind];
    const noun = `${ofKind.length} ${ofKind.length === 1 ? singular : plural}`;
    const ids = ofKind
        .filter((reference) => reference.id !== undefined)
        .map((reference) => JSON.stringify(reference.id));
    if (ids.length === 0) {
        const roles = readRoles?.(kind) ?? [];
        return roles.length > 0
            ? `${noun} (${roles.join(" or ")} shows which)`
            : noun;
    }
    const named = ids.slice(0, NAMED_PER_KIND);
    const more = ofKind.length - named.length;
    const names = more > 0 ? [...named, `${more} more`] : named;
    return `${noun} (${joinWithAnd(names)})`;
}

/**
 * The references without ID and description for the kinds the caller may not
 * read, so a refused delete does not reveal them; the count stays.
 */
export function keyChainReferencesVisibleTo(
    references: KeyChainReference[],
    mayRead: (kind: KeyChainReferenceKind) => boolean,
): KeyChainReference[] {
    return references.map((reference) =>
        mayRead(reference.kind) ? reference : { kind: reference.kind },
    );
}

/**
 * Names the configurations that use a key chain, such as `the issuance
 * configuration and 1 credential config ("pid")`; kinds whose references
 * carry no ID are only counted, with the roles that show them.
 */
export function describeKeyChainReferences(
    references: KeyChainReference[],
    readRoles?: KeyChainReferenceReadRoles,
): string {
    const parts = [
        references.some((reference) => reference.kind === "Tenant")
            ? "the tenant's default access key chain setting (defaultAccessKeyChainId)"
            : undefined,
        references.some((reference) => reference.kind === "IssuanceConfig")
            ? "the issuance configuration"
            : undefined,
        describeKind("CredentialConfig", references, readRoles),
        describeKind("PresentationConfig", references, readRoles),
        describeKind("StatusList", references, readRoles),
        describeKind("TrustList", references, readRoles),
    ].filter((part): part is string => part !== undefined);
    return joinWithAnd(parts);
}

/** Message that names the configurations that use the key chain. */
export function keyChainInUseMessage(
    keyChainId: string,
    references: KeyChainReference[],
    readRoles?: KeyChainReferenceReadRoles,
): string {
    return `Key chain ${JSON.stringify(keyChainId)} is still used by ${describeKeyChainReferences(references, readRoles)}. Remove these references before deleting the key chain.`;
}

/** Thrown when a key chain cannot be deleted because configurations name it. */
export class KeyChainInUseError extends Error {
    constructor(
        readonly keyChainId: string,
        readonly references: KeyChainReference[],
    ) {
        super(keyChainInUseMessage(keyChainId, references));
        this.name = "KeyChainInUseError";
    }
}
