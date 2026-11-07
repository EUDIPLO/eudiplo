import { KeyUsageType } from "../../../crypto/key/types/key-usage-type.js";

/** Fields of an internal trust list entity that name a key chain of the tenant. */
export type EntityKeyChainField = "issuerKeyChainId" | "revocationKeyChainId";

/**
 * Usage types whose certificate each field may publish. Only `attestation`
 * key chains sign credentials. Status lists are signed by a `statusList` key
 * chain, or by an `attestation` key chain when they are pinned to one or the
 * tenant has no `statusList` key chain, so both certify the revocation service.
 */
const ENTITY_KEY_CHAIN_USAGE_TYPES: Readonly<
    Record<EntityKeyChainField, readonly KeyUsageType[]>
> = {
    issuerKeyChainId: [KeyUsageType.Attestation],
    revocationKeyChainId: [KeyUsageType.StatusList, KeyUsageType.Attestation],
};

/** A key chain that an internal entity of a trust list names. */
export interface EntityKeyChainReference {
    /** Index of the entity in `entities`. */
    index: number;
    field: EntityKeyChainField;
    keyChainId: string;
}

const FIELDS = Object.keys(
    ENTITY_KEY_CHAIN_USAGE_TYPES,
) as EntityKeyChainField[];

/**
 * The key chains that the internal entities of `entities` name, in order.
 * Takes unvalidated input, so a bundle plan can read a document's `spec`;
 * values that are no non-empty string are left to schema validation.
 */
export function entityKeyChainReferences(
    entities: unknown,
): EntityKeyChainReference[] {
    if (!Array.isArray(entities)) return [];
    return entities.flatMap((entity: unknown, index) => {
        if (
            !entity ||
            typeof entity !== "object" ||
            (entity as { type?: unknown }).type !== "internal"
        ) {
            return [];
        }
        return FIELDS.flatMap((field) => {
            const keyChainId = (entity as Record<string, unknown>)[field];
            return typeof keyChainId === "string" && keyChainId !== ""
                ? [{ index, field, keyChainId }]
                : [];
        });
    });
}

type FieldReference = Pick<EntityKeyChainReference, "field" | "keyChainId">;

const referenceKey = ({ field, keyChainId }: FieldReference) =>
    `${field}\u0000${keyChainId}`;

/**
 * Tells whether a stored trust list already names a key chain in a field of
 * one of its internal entities. Lists stored before the usage check keep such
 * a value: a save or an import that leaves it unchanged is not refused for it.
 * Reads the stored entities once, so checking every reference of a large list
 * stays linear.
 */
export function storedEntityKeyChains(
    storedEntities: unknown,
): (reference: FieldReference) => boolean {
    const stored = new Set(
        entityKeyChainReferences(storedEntities).map(referenceKey),
    );
    return (reference) => stored.has(referenceKey(reference));
}

/**
 * Why the key chain cannot provide the certificate of `field`, or undefined
 * when its usage type fits.
 */
export function entityKeyChainUsageRefusal(
    field: EntityKeyChainField,
    keyChainId: string,
    usageType: unknown,
): string | undefined {
    const allowed = ENTITY_KEY_CHAIN_USAGE_TYPES[field];
    if (allowed.includes(usageType as KeyUsageType)) return undefined;
    const expected = allowed.map((type) => JSON.stringify(type)).join(" or ");
    return `Key chain ${JSON.stringify(keyChainId)} has usage type ${JSON.stringify(usageType)}; ${field} needs a key chain with usage type ${expected}.`;
}
