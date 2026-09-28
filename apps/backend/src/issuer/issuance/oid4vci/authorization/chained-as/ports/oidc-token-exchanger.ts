export interface OidcTokenExchangeInput {
    tokenEndpoint: string;
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret?: string;
    codeVerifier?: string;
}

export interface OidcTokenExchangeResult {
    accessToken: string;
    idToken?: string;
}

export const OIDC_TOKEN_EXCHANGER = Symbol("OIDC_TOKEN_EXCHANGER");

export interface OidcTokenExchanger {
    exchange(input: OidcTokenExchangeInput): Promise<OidcTokenExchangeResult>;
}
