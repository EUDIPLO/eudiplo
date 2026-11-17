/** Wallet requests of a presentation started for a sign-in. */
export interface StartedPresentation {
    /** ID of the presentation session. */
    sessionId: string;
    /** `openid4vp://` request for a wallet on the same device. */
    sameDeviceRequest: string;
    /** `openid4vp://` request for a wallet on another device. */
    crossDeviceRequest: string;
}

/** Result of the presentation of a sign-in, as far as it is known. */
export interface SignInPresentationResult {
    status: "open" | "completed" | "failed" | "expired";
    /**
     * The wallet fetched the request meant for another device, so it was not
     * sent back to a browser.
     */
    crossDevice: boolean;
    /** One-time code the wallet's redirect carries, once completed. */
    responseCode?: string;
    /** Disclosed claims per credential query, once completed. */
    credentials?: unknown[];
    /**
     * A unique identity of the trusted issuer each credential query matched
     * (`x509:<certificate thumbprint>` or `federation:<entity ID>`), once
     * completed.
     */
    issuers?: Record<string, string>;
    /** Short, safe reason of a failure. */
    failureReason?: string;
}

/**
 * The OID4VP verifier as the OpenID Provider uses it: start a presentation
 * for a presentation config and read its result.
 */
export interface SignInPresentation {
    /**
     * Why the config cannot verify a sign-in, or undefined when it can. With
     * `subjectCredentialId`, the config must also have that credential query
     * with `trusted_authorities`: a stable subject must not rest on a claim
     * any issuer could have signed.
     */
    unusableReason(
        tenantId: string,
        presentationConfigId: string,
        subjectCredentialId?: string,
    ): Promise<string | undefined>;
    start(
        tenantId: string,
        presentationConfigId: string,
        callbackUrl: string,
    ): Promise<StartedPresentation>;
    result(
        tenantId: string,
        sessionId: string,
    ): Promise<SignInPresentationResult>;
}

export const SIGN_IN_PRESENTATION = Symbol("SIGN_IN_PRESENTATION");
