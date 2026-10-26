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

/** The tenant, when one of its `defaultKeyChains` is the key chain. */
export class TypeOrmTenantKeyChainReferences
    implements KeyChainReferenceSource
{
    readonly kind = "Tenant";

    constructor(private readonly repository: Repository<TenantEntity>) {}

    namesKeyChain(config: unknown, keyChain: ReferencedKeyChain): boolean {
        return namesKeyChain(
            (config as Partial<TenantEntity> | null)?.defaultKeyChains,
            keyChain,
        );
    }

    async findReferences(
        keyChain: ReferencedKeyChain,
    ): Promise<KeyChainReference[]> {
        const tenant = await this.repository.findOne({
            where: { id: keyChain.tenantId },
            select: { id: true, defaultKeyChains: true },
        });
        return namesKeyChain(tenant?.defaultKeyChains, keyChain)
            ? [{ kind: "Tenant" }]
            : [];
    }
}
