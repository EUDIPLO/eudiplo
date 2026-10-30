import type { Repository } from "typeorm";
import {
    type KeyChainReference,
    keyChainIdNamesKeyChain,
    type ReferencedKeyChain,
} from "../../../../crypto/key/domain/key-chain-reference.js";
import type { KeyChainReferenceSource } from "../../../../crypto/key/ports/key-chain-reference-source.js";
import type { IssuanceConfig } from "../entities/issuance-config.entity.js";

/**
 * The tenant's issuance configuration, when the `token.signingKeyId` of an
 * authorization server names the key chain.
 */
export class TypeOrmIssuanceConfigKeyChainReferences
    implements KeyChainReferenceSource
{
    readonly kind = "IssuanceConfig";

    constructor(private readonly repository: Repository<IssuanceConfig>) {}

    namesKeyChain(config: unknown, keyChain: ReferencedKeyChain): boolean {
        const { authorizationServers } =
            (config as Partial<IssuanceConfig> | null) ?? {};
        const servers: unknown = authorizationServers;
        return (
            Array.isArray(servers) &&
            servers.some((server) =>
                keyChainIdNamesKeyChain(server?.token?.signingKeyId, keyChain),
            )
        );
    }

    async findReferences(
        keyChain: ReferencedKeyChain,
    ): Promise<KeyChainReference[]> {
        const config = await this.repository.findOne({
            where: { tenantId: keyChain.tenantId },
            select: {
                tenantId: true,
                authorizationServers: true,
            },
        });
        return config && this.namesKeyChain(config, keyChain)
            ? [{ kind: "IssuanceConfig" }]
            : [];
    }
}
