import type { Jwk } from "@owf/jose";
import type { SessionData } from "../../../../session/domain/session-data.js";
import { CredentialsService } from "../../../configuration/credentials/credentials.service.js";
import type { WalletUnitReference } from "../../../status-list/domain/wallet-unit-reference.js";
import type { DeferredCredentialIssuer } from "../ports/deferred-transaction.repository.js";

export class CredentialsServiceDeferredCredentialIssuer
    implements DeferredCredentialIssuer
{
    constructor(private readonly credentials: CredentialsService) {}

    issue(
        credentialConfigurationId: string,
        holderCnf: Jwk | undefined,
        session: SessionData,
        claims: Record<string, unknown>,
        issuanceSetId?: string,
        walletUnit?: WalletUnitReference,
    ): Promise<string> {
        return this.credentials.getCredential(
            credentialConfigurationId,
            holderCnf,
            session,
            claims,
            issuanceSetId,
            walletUnit,
        );
    }
}
