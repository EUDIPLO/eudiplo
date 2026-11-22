import type { StatusListService } from "../../../status-list/status-list.service.js";
import type { IssuedCredentialRevocation } from "../ports/issued-credential-revocation.js";

/** Revokes issued credentials through their entries in the status lists. */
export class StatusListIssuedCredentialRevocation
    implements IssuedCredentialRevocation
{
    constructor(
        private readonly statusLists: Pick<
            StatusListService,
            "revokeCredentialConfigurationEntries"
        >,
    ) {}

    revokeIssuedUnder(
        tenantId: string,
        credentialConfigurationId: string,
    ): Promise<number> {
        return this.statusLists.revokeCredentialConfigurationEntries(
            tenantId,
            credentialConfigurationId,
        );
    }
}
