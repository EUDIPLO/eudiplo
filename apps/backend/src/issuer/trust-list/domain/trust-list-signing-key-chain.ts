import { KeyUsageType } from "../../../crypto/key/types/key-usage-type.js";

/** The key chain a create or update of a trust list signs with. */
export interface TrustListSigningKeyChain {
    id: string;
    /**
     * Whether it is the key chain the stored list is signed with, because
     * the update names no `keyChainId`.
     */
    kept: boolean;
}

/**
 * The key chain that signs a trust list on a create or update: the one in
 * `keyChainId`, else the one the stored list is signed with. Undefined when
 * neither is set; a new list then uses a `trustList` key chain of the tenant.
 */
export function trustListSigningKeyChain(
    keyChainId: string | undefined,
    storedKeyChainId: string | undefined,
): TrustListSigningKeyChain | undefined {
    const id = keyChainId ?? storedKeyChainId;
    return id ? { id, kept: id !== keyChainId } : undefined;
}

/**
 * Why the key chain cannot sign a trust list, or undefined when its usage
 * type is `trustList`. A key chain import that reuses the ID of a list's key
 * chain can change its usage type, so a kept key chain is checked as well.
 */
export function trustListKeyChainUsageRefusal(
    signing: TrustListSigningKeyChain,
    usageType: unknown,
): string | undefined {
    if (usageType === KeyUsageType.TrustList) return undefined;
    return signing.kept
        ? `Key chain ${signing.id} of this trust list is not valid for Trust List usage (key lacks TrustList usage). Name a key chain with usage type trustList in keyChainId.`
        : `Key chain ${signing.id} is not valid for Trust List usage (key lacks TrustList usage)`;
}
