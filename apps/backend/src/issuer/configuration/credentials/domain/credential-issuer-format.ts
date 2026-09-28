import type { Jwk } from "@openid4vc/oauth2";
import type { SessionData } from "../../../../session/domain/session-data.js";

export interface CredentialIssuanceContext {
    credentialConfiguration: CredentialIssuanceDefinition;
    holderKey: Jwk;
    session: SessionData;
    claims: Record<string, unknown>;
    federationEntityId?: string;
    issuanceSetId?: string;
}

interface CredentialIssuanceDefinition {
    id: string;
    tenantId?: string;
    tenant?: unknown;
    keyChainId?: string;
    statusManagement?: unknown;
    lifeTime?: number | null;
    keyBinding?: boolean;
    fields: unknown[];
    vct?: unknown;
    sdJwtTrustFormat?: string | null;
    config: {
        format: string;
        display: unknown[];
        docType?: string;
        doctype?: string;
    };
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
