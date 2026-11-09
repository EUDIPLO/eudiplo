/**
 * The wallet unit attestation a credential was bound to: the key attestation
 * of its proof (OpenID4VCI 1.0, Appendix D.1) whose `status_list` says
 * whether the wallet provider revoked the wallet unit. Kept with the
 * credential's status entry so that the credential can be revoked when the
 * wallet unit is.
 */
export interface WalletUnitReference {
    /** `status.status_list.uri` of the key attestation. */
    statusUri: string;
    /** `status.status_list.idx` of the key attestation. */
    statusIdx: number;
    /**
     * `x5c` of the key attestation, leaf first, to match its provider in the
     * wallet-provider trust lists and check who signed the status list.
     */
    certificates: string[];
}
