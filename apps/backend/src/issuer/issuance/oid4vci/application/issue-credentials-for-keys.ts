import type { Jwk } from "@openid4vc/oauth2";
import type { SessionData } from "../../../../session/domain/session-data.js";
import type { WalletUnitReference } from "../../../status-list/domain/wallet-unit-reference.js";
import type { CredentialBatchIssuer } from "../ports/credential-batch-issuer.js";

export interface IssueCredentialsForKeysInput {
    credentialConfigurationId: string;
    holderKeys: Jwk[];
    session: SessionData;
    claims?: Record<string, unknown>;
    issuanceSetId: string;
    /** Wallet unit attestation that attested the holder keys, if any. */
    walletUnit?: WalletUnitReference;
}

export class IssueCredentialsForKeys {
    constructor(private readonly issuer: CredentialBatchIssuer) {}

    async execute(input: IssueCredentialsForKeysInput): Promise<string[]> {
        const credentials: string[] = [];
        for (const holderKey of input.holderKeys) {
            credentials.push(
                await this.issuer.issue(
                    input.credentialConfigurationId,
                    holderKey,
                    input.session,
                    input.claims,
                    input.issuanceSetId,
                    input.walletUnit,
                ),
            );
        }
        return credentials;
    }
}
