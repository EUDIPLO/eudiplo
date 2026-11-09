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
                sessionId: "session-1",
                credentialConfigurationId: "pid",
                walletUnitStatusUri: walletUnit.statusUri,
                walletUnitStatusIdx: 7,
                walletUnitCertificates: ["leaf", "ca"],
                credentialExpiresAt: expiresAt,
            },
        ]);
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

        expect(await records()).toEqual([]);
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
        const page = (after?: { statusListId: string; index: number }) =>
            store
                .findByStatusList(TENANT, walletUnit.statusUri, now, {
                    after,
                    limit: 1,
                })
                .then((records) => records.map((record) => record.index));
        expect(await page()).toEqual([0]);
        expect(await page({ statusListId: "list-1", index: 0 })).toEqual([1]);
        expect(await page({ statusListId: "list-1", index: 1 })).toEqual([]);

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
