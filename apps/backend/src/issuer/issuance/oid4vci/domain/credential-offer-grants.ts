import type {
    CredentialOfferAuthorizationCodeGrant,
    CredentialOfferPreAuthorizedCodeGrant,
} from "@openid4vc/openid4vci";
export type CredentialOfferGrants = Record<
    string,
    | CredentialOfferAuthorizationCodeGrant
    | CredentialOfferPreAuthorizedCodeGrant
>;
