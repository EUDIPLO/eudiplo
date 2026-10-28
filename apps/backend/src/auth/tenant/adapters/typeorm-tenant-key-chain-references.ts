import type { Repository } from "typeorm";
import {
    type KeyChainReference,
    keyChainIdNamesKeyChain,
    type ReferencedKeyChain,
} from "../../../crypto/key/domain/key-chain-reference.js";
import type { KeyChainReferenceSource } from "../../../crypto/key/ports/key-chain-reference-source.js";
import type { DefaultKeyChains } from "../domain/tenant-data.js";
import type { TenantEntity } from "../entities/tenant.entity.js";

/**
 * True when an entry of the map names the key chain. Documents of an import
 * reach it before validation, so other values name none.
 */
function namesKeyChain(
    defaultKeyChains: DefaultKeyChains | null | undefined,
    keyChain: ReferencedKeyChain,
): boolean {
    if (!defaultKeyChains || typeof defaultKeyChains !== "object") return false;
    return Object.values(defaultKeyChains).some((id) =>
        keyChainIdNamesKeyChain(id, keyChain),
    );
}

/**
 * The key chain defaults, stored on the tenant, when one of their entries is
 * the key chain.
 */
export class TypeOrmTenantKeyChainReferences
    implements KeyChainReferenceSource
{
    readonly kind = "KeyChainDefaults";

    constructor(private readonly repository: Repository<TenantEntity>) {}

    /** `config` is the spec of a KeyChainDefaults document: the map itself. */
    namesKeyChain(config: unknown, keyChain: ReferencedKeyChain): boolean {
        return namesKeyChain(config as DefaultKeyChains | null, keyChain);
    }

    async findReferences(
        keyChain: ReferencedKeyChain,
    ): Promise<KeyChainReference[]> {
        const tenant = await this.repository.findOne({
            where: { id: keyChain.tenantId },
            select: { id: true, defaultKeyChains: true },
        });
        return namesKeyChain(tenant?.defaultKeyChains, keyChain)
            ? [{ kind: "KeyChainDefaults" }]
            : [];
    }
}
