/**
 * OID4VP authorization response with a DCQL `vp_token`, as the verifier
 * processes it. Parsed with `@openid4vc/openid4vp` in
 * `ParseAuthorizationResponse`.
 */
export interface AuthResponseData {
    /**
     * Presentations per DCQL credential query id (OID4VP 1.0 §8.1). Every id
     * maps to at least one presentation; an empty array is rejected while
     * parsing, so it never counts as presented.
     */
    vp_token: Record<string, string[]>;
    state?: string;
}
