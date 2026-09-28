import type { CredentialOfferObject } from "@openid4vc/openid4vci";
import type { SessionData } from "../../../../session/domain/session-data.js";
import type { CredentialOfferGrants } from "../domain/credential-offer-grants.js";

export interface CredentialOfferProtocol {
    selectAuthorizationServer(
        tenantId: string,
        selected?: string,
    ): Promise<{ issuer: string; sessionServerId?: string }>;
    validateClaims(
        tenantId: string,
        configurationId: string,
        claims: Record<string, unknown>,
    ): Promise<void>;
    encode(
        session: SessionData,
        configurationIds: string[],
        grants: CredentialOfferGrants,
    ): Promise<{ object: CredentialOfferObject; uri: string }>;
}
export const CREDENTIAL_OFFER_PROTOCOL = Symbol("CREDENTIAL_OFFER_PROTOCOL");
