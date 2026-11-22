import type { AttestationKind } from "../../../trust/domain/attestation-status-claims.js";
import type { TrustListRef } from "../../../trust/types.js";
import type { WalletUnitReference } from "../../status-list/domain/wallet-unit-reference.js";

/** A status entry of an issued credential. */
export interface CredentialStatusEntry {
    statusListId: string;
    index: number;
}

/**
 * One record of a status entry: a credential has up to one per attestation
 * it follows.
 */
export interface WalletUnitRecordKey extends CredentialStatusEntry {
    /** `key` for the key attestation, `wallet` for the wallet attestation. */
    attestationKind: AttestationKind;
}

/** An issued credential's status entry and a wallet unit attestation it was bound to. */
export interface CredentialBoundToWalletUnit extends WalletUnitRecordKey {
    tenantId: string;
    sessionId: string;
    credentialConfigurationId: string;
    walletUnit: WalletUnitReference;
}

/** The wallet unit attestations recorded with issued credentials. */
export interface CredentialWalletUnitStore {
    /** Delete the records of credentials that expired before `now`. */
    deleteExpired(now: Date): Promise<void>;
    /**
     * The wallet unit status lists named by records of credentials that have
     * not expired, per tenant.
     */
    listStatusLists(now: Date): Promise<{ tenantId: string; uri: string }[]>;
    /**
     * One page of the records of credentials that have not expired, of one
     * list, in the order of their status entry and attestation kind, after
     * the record `after`.
     */
    findByStatusList(
        tenantId: string,
        uri: string,
        now: Date,
        page: { after?: WalletUnitRecordKey; limit: number },
    ): Promise<CredentialBoundToWalletUnit[]>;
    /** Stop checking these entries, for every attestation they follow. */
    delete(
        tenantId: string,
        entries: readonly CredentialStatusEntry[],
    ): Promise<void>;
}

/** Reads the status of wallet unit attestations from their provider. */
export interface WalletUnitStatusReader {
    /**
     * Read the status of several attestations of one provider in one status
     * list, verifying the list once.
     * @param certificates The `x5c` the attestations are signed under
     * @returns The status value per index
     * @throws Error when the provider is not trusted or the list cannot be
     * fetched, verified or read
     */
    read(
        tenantId: string,
        uri: string,
        certificates: string[],
        indexes: number[],
        trustLists: TrustListRef[],
    ): Promise<Map<number, number>>;
}

/** The status entries of the issued credentials. */
export interface IssuedCredentialStatus {
    /** Current values keyed by `<statusListId>:<index>`; missing lists are left out. */
    currentValues(
        tenantId: string,
        entries: readonly CredentialStatusEntry[],
    ): Promise<Map<string, number>>;
    /** @returns The entries that were revoked by this call */
    revoke(
        tenantId: string,
        entries: readonly CredentialStatusEntry[],
    ): Promise<CredentialStatusEntry[]>;
    /** The status list URI of a credential's status entry. */
    uri(tenantId: string, statusListId: string): string;
}

/** The tenant settings the check depends on. */
export interface WalletUnitRevocationSettingsSource {
    /** The wallet-provider trust lists of the tenant's issuance configuration. */
    walletProviderTrustLists(tenantId: string): Promise<TrustListRef[]>;
    /**
     * Whether the credential configuration still revokes its credentials
     * with their wallet unit; false when it no longer exists.
     */
    revokesWithWalletUnit(
        tenantId: string,
        credentialConfigurationId: string,
    ): Promise<boolean>;
}

/** Credentials of one session and configuration revoked with their wallet unit. */
export interface CredentialsRevokedWithWalletUnit {
    tenantId: string;
    sessionId: string;
    credentialConfigurationId: string;
    /** The status entries that were revoked, as in the credentials. */
    statusEntries: { uri: string; idx: number }[];
}

/** Tells the issuer's backend about credentials revoked with their wallet unit. */
export interface WalletUnitRevocationNotifier {
    /** Best effort: a failed delivery is logged, not thrown. */
    credentialsRevoked(event: CredentialsRevokedWithWalletUnit): Promise<void>;
}
