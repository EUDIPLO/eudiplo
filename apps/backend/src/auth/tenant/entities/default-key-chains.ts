import { ApiPropertyOptional } from "@nestjs/swagger";

/**
 * The tenant's key chain per usage type, used where no configuration names
 * one. A usage type without an entry uses a key chain picked by rule.
 */
export class DefaultKeyChains {
    @ApiPropertyOptional({
        description:
            "Access key chain that signs presentation requests of configurations without accessKeyChainId and the signed issuer metadata. Without it, EUDIPLO picks one of the tenant's access key chains by rule.",
    })
    access?: string;

    @ApiPropertyOptional({
        description:
            "Authorization server key chain (usage type authorizationServer) that signs the access tokens of authorization servers without token.signingKeyId and is published in their JWKS. Without it, EUDIPLO uses the tenant's oldest authorization server key chain and creates one with ID authorization-server when the tenant has none.",
    })
    authorizationServer?: string;
}
