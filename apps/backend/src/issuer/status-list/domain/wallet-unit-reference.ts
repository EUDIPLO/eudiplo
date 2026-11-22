/**
 * A wallet unit attestation a credential was bound to: the key attestation
 * of its proof (OpenID4VCI 1.0, Appendix D.1) or the wallet attestation of
 * its access token (Appendix E), whose `status_list` says whether the wallet
 * provider revoked the wallet unit (TS3 1.5: the wallet instance or its key
 * storage). Kept with the credential's status entry so that the credential
 * can be revoked when the wallet unit is.
 */
/**
 * Largest `status_list.idx` of a wallet unit that can be stored (int4). A
 * larger index lies outside any status list EUDIPLO reads (a list inflates
 * to at most 16 MiB).
 */
export const MAX_WALLET_UNIT_STATUS_INDEX = 2_147_483_647;

export interface WalletUnitReference {
    /**
     * `status_list.uri` the attestation names (`key_storage_status.status`
     * or `client_status.status`, else `status`).
     */
    statusUri: string;
    /** `status_list.idx` the attestation names, from the same claim. */
    statusIdx: number;
    /**
     * `x5c` of the attestation, leaf first, to match its provider in the
     * wallet-provider trust lists and check who signed the status list.
     */
    certificates: string[];
}
