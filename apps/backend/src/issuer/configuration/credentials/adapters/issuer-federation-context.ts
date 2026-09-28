import type { FederationTrustService } from "../../../../trust/federation-trust.service.js";
import type { IssuanceService } from "../../issuance/issuance.service.js";
import type { IssuerFederationContext } from "../ports/credential-generation-context.js";

export class ConfiguredIssuerFederationContext
    implements IssuerFederationContext
{
    constructor(
        private readonly issuance: Pick<
            IssuanceService,
            "getIssuanceConfiguration"
        >,
        private readonly federation: Pick<FederationTrustService, "isEnabled">,
    ) {}
    async entityIdForTenant(tenantId: string) {
        const config = await this.issuance.getIssuanceConfiguration(tenantId);
        return config.federation && this.federation.isEnabled(config.federation)
            ? config.federation.entityId
            : undefined;
    }
}
