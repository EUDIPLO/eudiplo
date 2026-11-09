import { describe, expect, it, vi } from "vitest";
import type {
    CredentialBoundToWalletUnit,
    CredentialStatusEntry,
} from "../ports/wallet-unit-revocation.ports.js";
import { CheckWalletUnitStatus } from "./check-wallet-unit-status.js";

const TENANT = "tenant-1";
const URI = "https://wp.example/wua-status";
const NOW = new Date("2026-11-09T12:00:00Z");
const LIST_URI =
    "https://issuer.example/issuers/tenant-1/status-management/status-list/list-1";

function record(
    index: number,
    overrides: Partial<CredentialBoundToWalletUnit> = {},
    walletUnitIdx = 7,
    certificates = ["leaf"],
): CredentialBoundToWalletUnit {
    return {
        tenantId: TENANT,
        statusListId: "list-1",
        index,
        sessionId: "session-1",
        credentialConfigurationId: "pid",
        walletUnit: { statusUri: URI, statusIdx: walletUnitIdx, certificates },
        ...overrides,
    };
}

const key = (entry: CredentialStatusEntry) =>
    `${entry.statusListId}:${String(entry.index).padStart(6, "0")}`;
const valueKey = (entry: CredentialStatusEntry) =>
    `${entry.statusListId}:${entry.index}`;

function setup(options: {
    records: CredentialBoundToWalletUnit[];
    walletUnitStatus?: Record<number, number>;
    readError?: Error;
    currentValues?: Map<string, number>;
    disabledConfigurations?: string[];
    alreadyRevoked?: string[];
    pageSize?: number;
}) {
    const sorted = [...options.records].sort((a, b) =>
        key(a) < key(b) ? -1 : 1,
    );
    const store = {
        deleteExpired: vi.fn(async () => undefined),
        listStatusLists: vi.fn(async () => [{ tenantId: TENANT, uri: URI }]),
        findByStatusList: vi.fn(
            async (
                _tenant: string,
                _uri: string,
                _now: Date,
                page: { after?: CredentialStatusEntry; limit: number },
            ) => {
                const start = page.after
                    ? sorted.findIndex((r) => key(r) === key(page.after!)) + 1
                    : 0;
                return sorted.slice(start, start + page.limit);
            },
        ),
        delete: vi.fn(async () => undefined),
    };
    const reader = {
        read: vi.fn(
            async (
                _tenant: string,
                _uri: string,
                _certificates: string[],
                indexes: number[],
            ) => {
                if (options.readError) throw options.readError;
                return new Map(
                    indexes.map((index) => [
                        index,
                        options.walletUnitStatus?.[index] ?? 0,
                    ]),
                );
            },
        ),
    };
    const credentials = {
        currentValues: vi.fn(
            async (
                _tenant: string,
                entries: readonly CredentialStatusEntry[],
            ) =>
                options.currentValues ??
                new Map(entries.map((entry) => [valueKey(entry), 0])),
        ),
        revoke: vi.fn(
            async (
                _tenant: string,
                entries: readonly CredentialStatusEntry[],
            ) =>
                entries
                    .filter(
                        (entry) =>
                            !options.alreadyRevoked?.includes(valueKey(entry)),
                    )
                    .map(({ statusListId, index }) => ({
                        statusListId,
                        index,
                    })),
        ),
        uri: (tenantId: string, listId: string) =>
            `https://issuer.example/issuers/${tenantId}/status-management/status-list/${listId}`,
    };
    const settings = {
        walletProviderTrustLists: vi.fn(async () => [
            { trustListId: "providers", url: "" },
        ]),
        revokesWithWalletUnit: vi.fn(
            async (_tenant: string, id: string) =>
                !options.disabledConfigurations?.includes(id),
        ),
    };
    const notifier = { credentialsRevoked: vi.fn(async () => undefined) };
    const log = { info: vi.fn(), warn: vi.fn() };
    const check = new CheckWalletUnitStatus(
        store,
        reader,
        credentials,
        settings,
        notifier,
        log,
        () => NOW,
        options.pageSize,
    );
    return { check, store, reader, credentials, notifier, log };
}

describe("CheckWalletUnitStatus", () => {
    it("revokes the credentials of a revoked wallet unit, stops checking them and tells each session", async () => {
        const records = [
            record(0),
            record(1),
            record(2, { sessionId: "session-2" }),
        ];
        const { check, store, credentials, notifier } = setup({
            records,
            walletUnitStatus: { 7: 1 },
        });

        await check.execute();

        expect(store.deleteExpired).toHaveBeenCalledWith(NOW);
        expect(credentials.revoke).toHaveBeenCalledWith(TENANT, records);
        expect(store.delete).toHaveBeenCalledWith(TENANT, records);
        expect(notifier.credentialsRevoked.mock.calls).toEqual([
            [
                {
                    tenantId: TENANT,
                    sessionId: "session-1",
                    credentialConfigurationId: "pid",
                    statusEntries: [
                        { uri: LIST_URI, idx: 0 },
                        { uri: LIST_URI, idx: 1 },
                    ],
                },
            ],
            [
                {
                    tenantId: TENANT,
                    sessionId: "session-2",
                    credentialConfigurationId: "pid",
                    statusEntries: [{ uri: LIST_URI, idx: 2 }],
                },
            ],
        ]);
    });

    it("reads the list once per provider and revokes only revoked wallet units", async () => {
        const valid = record(0, {}, 7);
        const revoked = record(1, {}, 8);
        const otherProvider = record(2, {}, 9, ["other-leaf"]);
        const { check, reader, credentials } = setup({
            records: [valid, revoked, record(3, {}, 7), otherProvider],
            walletUnitStatus: { 8: 1 },
        });

        await check.execute();

        expect(reader.read.mock.calls).toEqual([
            [
                TENANT,
                URI,
                ["leaf"],
                [7, 8],
                [{ trustListId: "providers", url: "" }],
            ],
            [
                TENANT,
                URI,
                ["other-leaf"],
                [9],
                [{ trustListId: "providers", url: "" }],
            ],
        ]);
        expect(credentials.revoke).toHaveBeenCalledWith(TENANT, [revoked]);
    });

    it("works through the records page by page", async () => {
        const records = [0, 1, 2, 3, 4].map((index) =>
            record(index, {}, index),
        );
        const { check, store, credentials } = setup({
            records,
            walletUnitStatus: { 1: 1, 4: 1 },
            pageSize: 2,
        });

        await check.execute();

        expect(store.findByStatusList).toHaveBeenCalledTimes(3);
        expect(store.findByStatusList).toHaveBeenLastCalledWith(
            TENANT,
            URI,
            NOW,
            { after: { statusListId: "list-1", index: 3 }, limit: 2 },
        );
        expect(credentials.revoke.mock.calls).toEqual([
            [TENANT, [records[1]]],
            [TENANT, [records[4]]],
        ]);
    });

    it("tells the webhook only about entries this run revoked", async () => {
        const { check, notifier } = setup({
            records: [
                record(0),
                record(1),
                record(2, { sessionId: "session-2" }),
            ],
            walletUnitStatus: { 7: 1 },
            alreadyRevoked: ["list-1:1", "list-1:2"],
        });

        await check.execute();

        expect(notifier.credentialsRevoked.mock.calls).toEqual([
            [
                expect.objectContaining({
                    sessionId: "session-1",
                    statusEntries: [{ uri: LIST_URI, idx: 0 }],
                }),
            ],
        ]);
    });

    it("revokes nothing while the wallet unit is valid", async () => {
        const { check, credentials, store, notifier } = setup({
            records: [record(0)],
        });

        await check.execute();

        expect(credentials.revoke).not.toHaveBeenCalled();
        expect(store.delete).not.toHaveBeenCalled();
        expect(notifier.credentialsRevoked).not.toHaveBeenCalled();
    });

    it("revokes nothing when the status cannot be read, and tries again next time", async () => {
        const { check, credentials, store, log } = setup({
            records: [record(0)],
            readError: new Error("status list unavailable"),
        });

        await check.execute();

        expect(credentials.revoke).not.toHaveBeenCalled();
        expect(store.delete).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledWith(
            expect.stringContaining("status list unavailable"),
        );
    });

    it("only logs a status other than revoked", async () => {
        const { check, credentials, log } = setup({
            records: [record(0)],
            walletUnitStatus: { 7: 2 },
        });

        await check.execute();

        expect(credentials.revoke).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledWith(
            expect.stringContaining("has status 2"),
        );
    });

    it("stops checking credentials that were revoked otherwise, whose list is gone, or whose configuration no longer follows the wallet unit", async () => {
        const revokedOtherwise = record(0);
        const listGone = record(1, { statusListId: "gone" });
        const disabled = record(2, { credentialConfigurationId: "loyalty" });
        const followed = record(3);
        const { check, store, reader } = setup({
            records: [revokedOtherwise, listGone, disabled, followed],
            // "gone" is not among the current values: its list was deleted.
            currentValues: new Map([
                ["list-1:0", 1],
                ["list-1:2", 0],
                ["list-1:3", 0],
            ]),
            disabledConfigurations: ["loyalty"],
        });

        await check.execute();

        expect(store.delete).toHaveBeenCalledWith(
            TENANT,
            expect.arrayContaining([revokedOtherwise, listGone, disabled]),
        );
        expect(reader.read).toHaveBeenCalledOnce();
        expect(reader.read.mock.calls[0][3]).toEqual([7]);
    });

    it("goes on with the next list when one cannot be checked", async () => {
        const { check, store, log } = setup({ records: [record(0)] });
        store.listStatusLists.mockResolvedValueOnce([
            { tenantId: TENANT, uri: "https://wp.example/broken" },
            { tenantId: TENANT, uri: URI },
        ]);
        store.findByStatusList.mockRejectedValueOnce(new Error("db down"));

        await check.execute();

        expect(store.findByStatusList).toHaveBeenCalledTimes(2);
        expect(log.warn).toHaveBeenCalledWith(
            expect.stringContaining("db down"),
        );
    });
});
