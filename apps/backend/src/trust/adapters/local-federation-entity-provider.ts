import { createEntityConfiguration } from "@owf/openid-federation";
import { toPublicJwk } from "../../crypto/key/domain/public-jwk.js";
import type { KeyChainService } from "../../crypto/key/key-chain.service.js";
import { KeyUsageType } from "../../crypto/key/types/key-usage-type.js";
import { trustMarkType } from "../domain/trust-mark.js";
import type {
    EntityConfigurationRequest,
    FederationEntityProvider,
} from "../ports/federation-entity-provider.js";

type FederationKeys = Pick<
    KeyChainService,
    "findByUsageType" | "signBytes" | "getSigningAlg"
>;

/**
 * Signs the entity configuration with the tenant's federation key chain
 * (usage type `federation`). Its active and previous public keys form the
 * federation `jwks`; protocol keys only appear inside the metadata.
 */
export class LocalFederationEntityProvider implements FederationEntityProvider {
    constructor(
        private readonly keys: FederationKeys,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async getEntityConfiguration({
        tenantId,
        entityId,
        keyChainId,
        content,
    }: EntityConfigurationRequest): Promise<string> {
        // The key first: without one, no metadata needs to be built.
        const keyChain = await this.keys.findByUsageType(
            tenantId,
            KeyUsageType.Federation,
            keyChainId,
        );
        const kid = keyChain.activeJwk.kid;
        if (!kid) {
            throw new Error(
                `Federation key chain ${keyChain.id} has no kid for its active key`,
            );
        }
        const alg = await this.keys.getSigningAlg(tenantId, keyChain.id);
        const statement = await content();
        const iat = Math.floor(this.now().getTime() / 1000);

        return createEntityConfiguration({
            header: { typ: "entity-statement+jwt", alg, kid },
            claims: {
                iss: entityId,
                sub: entityId,
                iat,
                exp: iat + statement.lifetimeSeconds,
                jwks: { keys: keyChain.getPublicKeys().map(toPublicJwk) },
                ...(statement.authorityHints.length > 0
                    ? { authority_hints: statement.authorityHints }
                    : {}),
                metadata: statement.metadata,
                ...(statement.trustMarks.length > 0
                    ? {
                          trust_marks: statement.trustMarks.map((jwt) => ({
                              trust_mark_type: requiredTrustMarkType(jwt),
                              trust_mark: jwt,
                          })),
                      }
                    : {}),
            } as Parameters<typeof createEntityConfiguration>[0]["claims"],
            signJwtCallback: ({ toBeSigned }) =>
                this.keys.signBytes(toBeSigned, tenantId, keyChain.id),
        });
    }
}

function requiredTrustMarkType(jwt: string): string {
    const type = trustMarkType(jwt);
    if (!type) {
        throw new Error("A configured trust mark has no trust_mark_type claim");
    }
    return type;
}
