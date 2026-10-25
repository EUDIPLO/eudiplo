import type { Repository } from "typeorm";
import {
    type KeyChainReference,
    keyChainIdNamesKeyChain,
    type ReferencedKeyChain,
} from "../../../crypto/key/domain/key-chain-reference.js";
import type { KeyChainReferenceSource } from "../../../crypto/key/ports/key-chain-reference-source.js";
import type { TenantEntity } from "../entities/tenant.entity.js";

/** The tenant, when its `defaultAccessKeyChainId` names the key chain. */
export class TypeOrmTenantKeyChainReferences
    implements KeyChainReferenceSource
{
    readonly kind = "Tenant";

    constructor(private readonly repository: Repository<TenantEntity>) {}

    namesKeyChain(config: unknown, keyChain: ReferencedKeyChain): boolean {
        return keyChainIdNamesKeyChain(
            (config as Partial<TenantEntity> | null)?.defaultAccessKeyChainId,
            keyChain,
        );
    }

    async findReferences(
        keyChain: ReferencedKeyChain,
    ): Promise<KeyChainReference[]> {
        const count = await this.repository.countBy({
            id: keyChain.tenantId,
            defaultAccessKeyChainId: keyChain.id,
        });
        return count > 0 ? [{ kind: "Tenant" }] : [];
    }
}
