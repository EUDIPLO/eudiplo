import "reflect-metadata";
import { DataSource } from "typeorm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ClientEntity } from "../../../auth/client/entities/client.entity.js";
import { TenantEntity } from "../../../auth/tenant/entities/tenant.entity.js";
import { ActiveCredentialSlot } from "../../status-list/entities/active-credential-slot.entity.js";
import { CredentialWalletUnit } from "../../status-list/entities/credential-wallet-unit.entity.js";
import { StatusListEntity } from "../../status-list/entities/status-list.entity.js";
import { StatusMapping } from "../../status-list/entities/status-mapping.entity.js";
import { StatusListService } from "../../status-list/status-list.service.js";
import { TypeOrmCredentialWalletUnitStore } from "./typeorm-credential-wallet-unit-store.js";

const TENANT = "tenant-1";
const walletUnit = {
    statusUri: "https://wp.example/wua-status",
    statusIdx: 7,
    certificates: ["leaf", "ca"],
};
const session = { id: "session-1", tenantId: TENANT } as never;

describe("wallet unit storage", () => {
    let dataSource: DataSource;
    let service: StatusListService;
    let store: TypeOrmCredentialWalletUnitStore;

    beforeEach(async () => {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: [
                ClientEntity,
                TenantEntity,
                StatusListEntity,
                StatusMapping,
                ActiveCredentialSlot,
                CredentialWalletUnit,
            ],
            synchronize: true,
        });
        await dataSource.initialize();
        service = new StatusListService(
            {
                publicUrl: "https://issuer.example",
                statusCapacity: 4,
                statusBits: 1,
            },
            {} as never,
            {} as never,
            dataSource,
            dataSource.getRepository(StatusMapping),
            dataSource.getRepository(StatusListEntity),
            dataSource.getRepository(TenantEntity),
            {} as never,
            {
                getEffectiveConfig: vi.fn(async () => ({
                    immediateUpdate: false,
                })),
            } as never,
            { register: vi.fn() } as never,
            dataSource.getRepository(ActiveCredentialSlot),
            {} as never,
            dataSource.getRepository(CredentialWalletUnit),
        );
        store = new TypeOrmCredentialWalletUnitStore(
            dataSource.getRepository(CredentialWalletUnit),
        );
        await dataSource.getRepository(TenantEntity).save({
            id: TENANT,
            name: "Tenant 1",
            status: "active",
        });
        await dataSource.getRepository(StatusListEntity).save({
            id: "list-1",
            tenantId: TENANT,
            credentialConfigurationId: null,
            bits: 2,
            stack: [3, 2, 1, 0],
            elements: [0, 0, 0, 0],
        });
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    const records = () => dataSource.getRepository(CredentialWalletUnit).find();

    test("records the wallet unit of an entry when the configuration revokes with it", async () => {
        const expiresAt = new Date("2027-01-01T00:00:00Z");
        const payload = await service.createEntry(
            session,
            "pid",
            { statusManagement: true, revokeWithWalletUnit: true },
            undefined,
            walletUnit,
            expiresAt,
        );

        expect(await records()).toEqual([
            {
                tenantId: TENANT,
                statusListId: "list-1",
                index: payload.status.status_list.idx,
                attestationKind: "key",
                sessionId: "session-1",
                credentialConfigurationId: "pid",
                walletUnitStatusUri: walletUnit.statusUri,
                walletUnitStatusIdx: 7,
                walletUnitCertificates: ["leaf", "ca"],
                credentialExpiresAt: expiresAt,
            },
        ]);
    });

    test("records the wallet attestation of the session next to the key attestation", async () => {
        const walletInstance = {
            statusUri: "https://wp.example/wia-status",
            statusIdx: 1337,
            certificates: ["wia-leaf"],
        };
        const withWia = {
            id: "session-1",
            tenantId: TENANT,
            walletInstanceStatus: walletInstance,
        } as never;
        const both = await service.createEntry(
            withWia,
            "pid",
            { statusManagement: true, revokeWithWalletUnit: true },
            undefined,
            walletUnit,
        );
        // Without key attestation, the wallet attestation alone.
        const walletOnly = await service.createEntry(
            withWia,
            "pid",
            { statusManagement: true, revokeWithWalletUnit: true },
            undefined,
            undefined,
        );

        const rows = (await records()).map((record) => [
            record.index,
            record.attestationKind,
            record.walletUnitStatusUri,
            record.walletUnitStatusIdx,
            record.walletUnitCertificates,
        ]);
        expect(rows).toEqual(
            expect.arrayContaining([
                [
                    both.status.status_list.idx,
                    "key",
                    walletUnit.statusUri,
                    7,
                    ["leaf", "ca"],
                ],
                [
                    both.status.status_list.idx,
                    "wallet",
                    walletInstance.statusUri,
                    1337,
                    ["wia-leaf"],
                ],
                [
                    walletOnly.status.status_list.idx,
                    "wallet",
                    walletInstance.statusUri,
                    1337,
                    ["wia-leaf"],
                ],
            ]),
        );
        expect(rows).toHaveLength(3);

        // Stopping an entry stops both of its records.
        await store.delete(TENANT, [
            { statusListId: "list-1", index: both.status.status_list.idx },
        ]);
        expect((await records()).map((record) => record.index)).toEqual([
            walletOnly.status.status_list.idx,
        ]);
    });

    test("pages through the records of one entry that follow two attestations in the same list", async () => {
        const now = new Date("2026-11-09T12:00:00Z");
        for (const attestationKind of ["key", "wallet"] as const) {
            await dataSource.getRepository(CredentialWalletUnit).insert({
                tenantId: TENANT,
                statusListId: "list-1",
                index: 0,
                attestationKind,
                sessionId: "session-1",
                credentialConfigurationId: "pid",
                walletUnitStatusUri: walletUnit.statusUri,
                walletUnitStatusIdx: attestationKind === "key" ? 1 : 2,
                walletUnitCertificates: ["leaf"],
                credentialExpiresAt: null,
            });
        }
        const page = (after?: {
            statusListId: string;
            index: number;
            attestationKind: "key" | "wallet";
        }) =>
            store
                .findByStatusList(TENANT, walletUnit.statusUri, now, {
                    after,
                    limit: 1,
                })
                .then((found) => found.map((record) => record.attestationKind));

        expect(await page()).toEqual(["key"]);
        expect(
            await page({
                statusListId: "list-1",
                index: 0,
                attestationKind: "key",
            }),
        ).toEqual(["wallet"]);
        expect(
            await page({
                statusListId: "list-1",
                index: 0,
                attestationKind: "wallet",
            }),
        ).toEqual([]);
    });

    test("records nothing when the configuration does not revoke with the wallet unit", async () => {
        await service.createEntry(
            session,
            "pid",
            { statusManagement: true },
            undefined,
            walletUnit,
        );
        await service.createEntry(
            session,
            "pid",
            { statusManagement: true, revokeWithWalletUnit: true },
            undefined,
            undefined,
        );
        // A wallet attestation on the session is not followed either.
        await service.createEntry(
            {
                id: "session-1",
                tenantId: TENANT,
                walletInstanceStatus: walletUnit,
            } as never,
            "pid",
            { statusManagement: true },
            undefined,
            walletUnit,
        );

        expect(await records()).toEqual([]);
    });

    test("deletes every record of the given entries of the tenant, and nothing else", async () => {
        await dataSource.getRepository(TenantEntity).save({
            id: "tenant-2",
            name: "Tenant 2",
            status: "active",
        });
        await dataSource.getRepository(StatusListEntity).save({
            id: "list-1",
            tenantId: "tenant-2",
            credentialConfigurationId: null,
            bits: 1,
            stack: [],
            elements: [0, 0, 0, 0],
        });
        const row = (
            tenantId: string,
            index: number,
            attestationKind: "key" | "wallet",
        ) => ({
            tenantId,
            statusListId: "list-1",
            index,
            attestationKind,
            sessionId: "session-1",
            credentialConfigurationId: "pid",
            walletUnitStatusUri: walletUnit.statusUri,
            walletUnitStatusIdx: index,
            walletUnitCertificates: ["leaf"],
            credentialExpiresAt: null,
        });
        await dataSource
            .getRepository(CredentialWalletUnit)
            .insert([
                row(TENANT, 0, "key"),
                row(TENANT, 0, "wallet"),
                row(TENANT, 1, "key"),
                row(TENANT, 2, "wallet"),
                row("tenant-2", 0, "key"),
            ]);

        await store.delete(TENANT, [
            { statusListId: "list-1", index: 0 },
            { statusListId: "list-1", index: 2 },
        ]);

        expect(
            (await records())
                .map((r) => `${r.tenantId}:${r.index}:${r.attestationKind}`)
                .sort(),
        ).toEqual(["tenant-1:1:key", "tenant-2:0:key"]);
    });

    test("finds the records of credentials that have not expired and deletes the others", async () => {
        const now = new Date("2026-11-09T12:00:00Z");
        for (const [index, expiresAt] of [
            [0, null],
            [1, new Date("2026-11-10T00:00:00Z")],
            [2, new Date("2026-11-09T11:00:00Z")],
        ] as const) {
            await dataSource.getRepository(CredentialWalletUnit).insert({
                tenantId: TENANT,
                statusListId: "list-1",
                index,
                attestationKind: "key",
                sessionId: "session-1",
                credentialConfigurationId: "pid",
                walletUnitStatusUri: walletUnit.statusUri,
                walletUnitStatusIdx: index,
                walletUnitCertificates: ["leaf"],
                credentialExpiresAt: expiresAt,
            });
        }

        expect(await store.listStatusLists(now)).toEqual([
            { tenantId: TENANT, uri: walletUnit.statusUri },
        ]);
        const page = (after?: {
            statusListId: string;
            index: number;
            attestationKind: "key" | "wallet";
        }) =>
            store
                .findByStatusList(TENANT, walletUnit.statusUri, now, {
                    after,
                    limit: 1,
                })
                .then((records) => records.map((record) => record.index));
        expect(await page()).toEqual([0]);
        expect(
            await page({
                statusListId: "list-1",
                index: 0,
                attestationKind: "key",
            }),
        ).toEqual([1]);
        expect(
            await page({
                statusListId: "list-1",
                index: 1,
                attestationKind: "key",
            }),
        ).toEqual([]);

        await store.deleteExpired(now);
        expect((await records()).map((record) => record.index).sort()).toEqual([
            0, 1,
        ]);

        await store.delete(TENANT, [{ statusListId: "list-1", index: 0 }]);
        expect((await records()).map((record) => record.index)).toEqual([1]);
    });

    test("revokes valid and suspended entries and leaves revoked ones", async () => {
        await dataSource
            .getRepository(StatusListEntity)
            .update(
                { id: "list-1", tenantId: TENANT },
                { elements: [0, 1, 2, 0], stack: [] },
            );
        const entries = [0, 1, 2].map((index) => ({
            statusListId: "list-1",
            index,
        }));

        await expect(service.revokeEntries(TENANT, entries)).resolves.toEqual([
            { statusListId: "list-1", index: 0 },
            { statusListId: "list-1", index: 2 },
        ]);
        const list = await dataSource
            .getRepository(StatusListEntity)
            .findOneByOrFail({ id: "list-1", tenantId: TENANT });
        expect(list.elements).toEqual([1, 1, 1, 0]);
    });

    test("reads current values and leaves out lists that no longer exist", async () => {
        await dataSource
            .getRepository(StatusListEntity)
            .update(
                { id: "list-1", tenantId: TENANT },
                { elements: [0, 1, 2, 0] },
            );

        const values = await service.currentValues(TENANT, [
            { statusListId: "list-1", index: 2 },
            { statusListId: "gone", index: 0 },
        ]);
        expect([...values]).toEqual([["list-1:2", 2]]);
    });
});
