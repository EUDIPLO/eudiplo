import type { Jwk } from "@openid4vc/oauth2";
import type { SessionData } from "../../../../session/domain/session-data.js";
import type { WalletUnitReference } from "../../../status-list/domain/wallet-unit-reference.js";
import type { CredentialConfiguration } from "./credential-configuration.js";

export interface CredentialIssuanceContext {
    credentialConfiguration: CredentialConfiguration;
    holderKey: Jwk;
    session: SessionData;
    claims: Record<string, unknown>;
    federationEntityId?: string;
    /** Trust chain for the `trust_chain` header of federation credentials. */
    federationTrustChain?: () => Promise<string[] | undefined>;
    issuanceSetId?: string;
    /** Wallet unit attestation that attested `holderKey`, if any. */
    walletUnit?: WalletUnitReference;
}

export interface CredentialIssuerFormat {
    readonly format: string;
    issue(context: CredentialIssuanceContext): Promise<string>;
}

export class UnsupportedCredentialFormat extends Error {
    constructor(format: string) {
        super(`Unsupported credential format '${format}'`);
        this.name = "UnsupportedCredentialFormat";
    }
}
