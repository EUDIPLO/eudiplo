import type { Jwk } from "@owf/jose";
import type { SessionData } from "../../../../session/domain/session-data.js";
import type { WalletUnitReference } from "../../../status-list/domain/wallet-unit-reference.js";
import type { CredentialBatchIssuer } from "../ports/credential-batch-issuer.js";

export interface IssueCredentialsForKeysInput {
    credentialConfigurationId: string;
    /**
     * One credential is issued per key. Without keys (a configuration that
     * needs no key proof), one credential bound to no key is issued.
     */
    holderKeys?: Jwk[];
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
        const holderKeys: (Jwk | undefined)[] = input.holderKeys ?? [undefined];
        for (const holderKey of holderKeys) {
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
