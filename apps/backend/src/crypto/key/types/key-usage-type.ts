/**
 * Key usage types for different purposes in the system.
 */
export enum KeyUsageType {
    /**
     * The X.509 access certificate of a relying party, issued by the
     * registrar or imported: signs OID4VP authorization requests, ISO
     * 18013-7 reader authentication and the signed issuer metadata.
     */
    Access = "access",
    /**
     * Signs the OAuth access tokens of EUDIPLO's authorization servers
     * (built-in, chained and OID4VP-based). Only EUDIPLO and the wallets'
     * credential requests rely on it, through the authorization servers'
     * JWKS, so it needs no certificate from a CA.
     */
    AccessToken = "accessToken",
    /** Used for credential/attestation signing (SD-JWT VC, mDOC, etc.) */
    Attestation = "attestation",
    /** Used for trust list signing */
    TrustList = "trustList",
    /** Used for status list (credential revocation) signing */
    StatusList = "statusList",
    /** Used for OpenID Federation entity statement signing (entity configuration) */
    Federation = "federation",
    /** Used for encryption (JWE) */
    Encrypt = "encrypt",
}
