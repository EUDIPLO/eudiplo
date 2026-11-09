import { STATUS_REVOKED } from "../../status-list/domain/status-value.js";
import type {
    CredentialBoundToWalletUnit,
    CredentialStatusEntry,
    CredentialWalletUnitStore,
    IssuedCredentialStatus,
    WalletUnitRevocationNotifier,
    WalletUnitRevocationSettingsSource,
    WalletUnitStatusReader,
} from "../ports/wallet-unit-revocation.ports.js";

/** Status value of a valid wallet unit attestation (Token Status List `0x00`). */
const STATUS_VALID = 0;

/** Records read and decided at once, so that memory stays bounded. */
const PAGE_SIZE = 500;

/** Where the check reports what it did and what it could not decide. */
export interface WalletUnitCheckLog {
    info(message: string): void;
    warn(message: string): void;
}

const entryKey = (entry: CredentialStatusEntry) =>
    `${entry.statusListId}:${entry.index}`;

/**
 * Revokes issued credentials whose wallet unit attestation was revoked
 * (Token Status List value `0x01`), for credential configurations with
 * `revokeWithWalletUnit`. A wallet unit is never suspended, so other values
 * are only logged.
 *
 * Nothing is revoked when the status cannot be decided: the provider is no
 * longer in the trust lists, or its list cannot be fetched, verified or
 * read. The next run tries again.
 *
 * Records end with the credential: once it is expired, revoked (by this
 * check or otherwise), or its configuration stops revoking with the wallet
 * unit, its record is deleted and it is no longer checked.
 */
export class CheckWalletUnitStatus {
    constructor(
        private readonly store: CredentialWalletUnitStore,
        private readonly reader: WalletUnitStatusReader,
        private readonly credentials: IssuedCredentialStatus,
        private readonly settings: WalletUnitRevocationSettingsSource,
        private readonly notifier: WalletUnitRevocationNotifier,
        private readonly log: WalletUnitCheckLog,
        private readonly now: () => Date = () => new Date(),
        private readonly pageSize = PAGE_SIZE,
    ) {}

    async execute(): Promise<void> {
        const now = this.now();
        await this.store.deleteExpired(now);
        for (const { tenantId, uri } of await this.store.listStatusLists(now)) {
            try {
                await this.checkStatusList(tenantId, uri, now);
            } catch (error) {
                this.log.warn(
                    `Wallet unit status list ${uri} of tenant ${tenantId} could not be checked: ${reason(error)}`,
                );
            }
        }
    }

    private async checkStatusList(
        tenantId: string,
        uri: string,
        now: Date,
    ): Promise<void> {
        const trustLists =
            await this.settings.walletProviderTrustLists(tenantId);
        let after: CredentialStatusEntry | undefined;
        for (;;) {
            const page = await this.store.findByStatusList(tenantId, uri, now, {
                after,
                limit: this.pageSize,
            });
            if (page.length === 0) return;
            const last = page[page.length - 1];
            after = { statusListId: last.statusListId, index: last.index };
            await this.checkPage(
                tenantId,
                uri,
                await this.followed(tenantId, page),
                trustLists,
            );
            if (page.length < this.pageSize) return;
        }
    }

    private async checkPage(
        tenantId: string,
        uri: string,
        records: CredentialBoundToWalletUnit[],
        trustLists: Awaited<
            ReturnType<
                WalletUnitRevocationSettingsSource["walletProviderTrustLists"]
            >
        >,
    ): Promise<void> {
        const revoked: CredentialBoundToWalletUnit[] = [];
        for (const group of groupBy(records, (record) =>
            JSON.stringify(record.walletUnit.certificates),
        )) {
            const indexes = [
                ...new Set(group.map((record) => record.walletUnit.statusIdx)),
            ];
            let statuses: Map<number, number>;
            try {
                statuses = await this.reader.read(
                    tenantId,
                    uri,
                    group[0].walletUnit.certificates,
                    indexes,
                    trustLists,
                );
            } catch (error) {
                this.log.warn(
                    `Status of ${indexes.length} wallet unit(s) in ${uri} of tenant ${tenantId} could not be read, their credentials stay as they are: ${reason(error)}`,
                );
                continue;
            }
            for (const index of indexes) {
                const status = statuses.get(index);
                if (status === undefined || status === STATUS_VALID) continue;
                if (status !== STATUS_REVOKED) {
                    this.log.warn(
                        `Wallet unit ${index} in ${uri} of tenant ${tenantId} has status ${status}; only a revoked wallet unit (1) revokes its credentials`,
                    );
                }
            }
            for (const record of group) {
                if (
                    statuses.get(record.walletUnit.statusIdx) === STATUS_REVOKED
                )
                    revoked.push(record);
            }
        }
        if (revoked.length > 0) await this.revoke(tenantId, uri, revoked);
    }

    /**
     * The records that are still followed. Records of credentials that were
     * revoked otherwise, of status lists that no longer exist, and of
     * configurations that no longer revoke with the wallet unit are deleted.
     */
    private async followed(
        tenantId: string,
        records: CredentialBoundToWalletUnit[],
    ): Promise<CredentialBoundToWalletUnit[]> {
        const values = await this.credentials.currentValues(tenantId, records);
        const enabled = new Map<string, boolean>();
        for (const id of new Set(
            records.map((r) => r.credentialConfigurationId),
        )) {
            enabled.set(
                id,
                await this.settings.revokesWithWalletUnit(tenantId, id),
            );
        }
        const kept: CredentialBoundToWalletUnit[] = [];
        const ended: CredentialBoundToWalletUnit[] = [];
        for (const record of records) {
            const value = values.get(entryKey(record));
            if (
                value === undefined ||
                value === STATUS_REVOKED ||
                !enabled.get(record.credentialConfigurationId)
            ) {
                ended.push(record);
            } else {
                kept.push(record);
            }
        }
        if (ended.length > 0) await this.store.delete(tenantId, ended);
        return kept;
    }

    private async revoke(
        tenantId: string,
        uri: string,
        records: CredentialBoundToWalletUnit[],
    ): Promise<void> {
        const revoked = new Set(
            (await this.credentials.revoke(tenantId, records)).map(entryKey),
        );
        await this.store.delete(tenantId, records);
        this.log.info(
            `Revoked ${revoked.size} credential(s) of tenant ${tenantId} whose wallet unit in ${uri} was revoked`,
        );

        // One webhook per issuance session and configuration, with the
        // entries this call revoked.
        for (const group of groupBy(
            records.filter((record) => revoked.has(entryKey(record))),
            (record) =>
                JSON.stringify([
                    record.sessionId,
                    record.credentialConfigurationId,
                ]),
        )) {
            await this.notifier.credentialsRevoked({
                tenantId,
                sessionId: group[0].sessionId,
                credentialConfigurationId: group[0].credentialConfigurationId,
                statusEntries: group.map((record) => ({
                    uri: this.credentials.uri(tenantId, record.statusListId),
                    idx: record.index,
                })),
            });
        }
    }
}

function groupBy<T>(items: T[], key: (item: T) => string): T[][] {
    const groups = new Map<string, T[]>();
    for (const item of items) {
        const k = key(item);
        const group = groups.get(k);
        if (group) group.push(item);
        else groups.set(k, [item]);
    }
    return [...groups.values()];
}

function reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
