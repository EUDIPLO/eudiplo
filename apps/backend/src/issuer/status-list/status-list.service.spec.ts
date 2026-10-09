import "reflect-metadata";
import { DataSource } from "typeorm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ClientEntity } from "../../auth/client/entities/client.entity.js";
import { TenantEntity } from "../../auth/tenant/entities/tenant.entity.js";
import { StatusListValuesOutOfRange } from "./domain/status-value.js";
import { ActiveCredentialSlot } from "./entities/active-credential-slot.entity.js";
import { StatusListEntity } from "./entities/status-list.entity.js";
import { StatusMapping } from "./entities/status-mapping.entity.js";
import {
    MAX_STATUS_LIST_CAPACITY,
    StatusListService,
} from "./status-list.service.js";

describe("StatusListService SQLite concurrency", () => {
    let dataSource: DataSource;
    let service: StatusListService;

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
            ],
            synchronize: true,
        });
        await dataSource.initialize();

        const orchestrator = { register: vi.fn() };

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
            {} as never,
            orchestrator as never,
            dataSource.getRepository(ActiveCredentialSlot),
            {} as never,
        );

        await dataSource.getRepository(TenantEntity).save({
            id: "tenant-1",
            name: "Tenant 1",
            status: "active",
        });
        await dataSource.getRepository(StatusListEntity).save({
            id: "list-1",
            tenantId: "tenant-1",
            credentialConfigurationId: null,
            elements: [0, 0],
            stack: [0, 1],
            bits: 1,
        });
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    test("config binding updates preserve revoked entries and allocated indexes", async () => {
        const repository = dataSource.getRepository(StatusListEntity);
        await repository.update(
            { tenantId: "tenant-1", id: "list-1" },
            { elements: [1, 0], stack: [1] },
        );
        await service.processStatusListConfig("tenant-1", {
            id: "list-1",
            capacity: 2,
            bits: 1,
            credentialConfigurationId: "new-binding",
        });
        const list = await repository.findOneByOrFail({
            tenantId: "tenant-1",
            id: "list-1",
        });
        expect(list.elements).toEqual([1, 0]);
        expect(list.stack).toEqual([1]);
        expect(list.credentialConfigurationId).toBe("new-binding");
    });

    test("refuses to reset an existing list's layout", async () => {
        await expect(
            service.processStatusListConfig("tenant-1", {
                id: "list-1",
                capacity: 100,
            }),
        ).rejects.toThrow("cannot change capacity or bits");
        await expect(
            service.processStatusListConfig("tenant-1", {
                id: "list-1",
                bits: 2,
            }),
        ).rejects.toThrow("cannot change capacity or bits");
        expect(
            (
                await dataSource
                    .getRepository(StatusListEntity)
                    .findOneByOrFail({ tenantId: "tenant-1", id: "list-1" })
            ).elements,
        ).toEqual([0, 0]);
    });

    test("detects concurrent allocations while validating a binding update", async () => {
        const repository = dataSource.getRepository(StatusListEntity);
        Object.assign(service, {
            certService: {
                find: async () => {
                    await repository.update(
                        { tenantId: "tenant-1", id: "list-1" },
                        { stack: [1] },
                    );
                    return {};
                },
            },
        });
        await expect(
            service.updateList("tenant-1", "list-1", { keyChainId: "new-key" }),
        ).rejects.toThrow("changed concurrently");
        expect(
            (
                await repository.findOneByOrFail({
                    tenantId: "tenant-1",
                    id: "list-1",
                })
            ).stack,
        ).toEqual([1]);
    });

    test("allocates an entry without unsupported pessimistic locks", async () => {
        const payload = await service.createEntry(
            { id: "session-1", tenantId: "tenant-1" } as never,
            "config-1",
        );

        expect(payload.status.status_list.uri).toBe(
            "https://issuer.example/issuers/tenant-1/status-management/status-list/list-1",
        );
        expect([0, 1]).toContain(payload.status.status_list.idx);

        const list = await dataSource
            .getRepository(StatusListEntity)
            .findOneByOrFail({ id: "list-1", tenantId: "tenant-1" });
        expect(list.stack).toHaveLength(1);
        expect(list.version).toBe(2);

        const mappings = await dataSource.getRepository(StatusMapping).find();
        expect(mappings).toHaveLength(1);
        expect(mappings[0].index).toBe(payload.status.status_list.idx);
    });

    test("does not cache tokens generated from a stale entity version", async () => {
        const repository = dataSource.getRepository(StatusListEntity);
        const snapshot = await repository.findOneByOrFail({
            id: "list-1",
            tenantId: "tenant-1",
        });

        Object.assign(service as object, {
            statusListConfigService: {
                getEffectiveConfig: vi.fn().mockResolvedValue({
                    ttl: 300,
                    enableAggregation: false,
                }),
            },
            certService: {
                find: vi.fn().mockResolvedValue({
                    keyId: "status-list-key",
                    crt: [],
                }),
                getLeafCertBase64: vi.fn().mockReturnValue(["certificate"]),
            },
            keyChainService: {
                signJWT: vi.fn().mockImplementation(async () => {
                    await repository.update(
                        {
                            id: snapshot.id,
                            tenantId: snapshot.tenantId,
                            version: snapshot.version,
                        },
                        {
                            elements: [1, 0],
                            version: () => "version + 1",
                        },
                    );
                    return "stale-jwt";
                }),
            },
            signStatusListCwt: vi.fn().mockResolvedValue(Uint8Array.of(1)),
        });

        await expect(service.createListJWT(snapshot)).resolves.toBe(false);

        const current = await repository.findOneByOrFail({
            id: snapshot.id,
            tenantId: snapshot.tenantId,
        });
        expect(current.elements).toEqual([1, 0]);
        expect(current.version).toBe(snapshot.version + 1);
        expect(current.jwt).toBeNull();
        expect(current.cwt).toBeNull();
    });

    test("allocates concurrently without transaction conflicts", async () => {
        // SQLite hands every query runner the same connection, so two
        // transactions opened at once collide and the failure surfaces as
        // "cannot rollback - no transaction is active". Allocation is
        // serialised on such drivers; this asserts concurrent callers still
        // each get a distinct index.
        await dataSource
            .getRepository(StatusListEntity)
            .update(
                { id: "list-1", tenantId: "tenant-1" },
                { elements: [0, 0, 0, 0], stack: [0, 1, 2, 3] },
            );

        const results = await Promise.all([
            service.createEntry(
                { id: "session-a", tenantId: "tenant-1" } as never,
                "config-1",
            ),
            service.createEntry(
                { id: "session-b", tenantId: "tenant-1" } as never,
                "config-1",
            ),
            service.createEntry(
                { id: "session-c", tenantId: "tenant-1" } as never,
                "config-1",
            ),
        ]);

        const indices = results.map((result) => result.status.status_list.idx);
        expect(new Set(indices).size).toBe(3);

        const mappings = await dataSource
            .getRepository(StatusMapping)
            .findBy({ tenantId: "tenant-1" });
        expect(mappings).toHaveLength(3);
    });

    test("allocates concurrently when a new list must be created", async () => {
        Object.assign(service as object, {
            statusListConfigService: {
                getEffectiveConfig: vi.fn().mockResolvedValue({
                    ttl: 300,
                    enableAggregation: false,
                }),
            },
            certService: {
                find: vi.fn().mockResolvedValue({
                    keyId: "status-list-key",
                    crt: [],
                }),
                getLeafCertBase64: vi.fn().mockReturnValue(["certificate"]),
            },
            keyChainService: {
                signJWT: vi.fn().mockResolvedValue("jwt"),
            },
            signStatusListCwt: vi.fn().mockResolvedValue(Uint8Array.of(1)),
        });
        await dataSource
            .getRepository(StatusListEntity)
            .update({ id: "list-1", tenantId: "tenant-1" }, { stack: [] });

        const results = await Promise.all([
            service.createEntry(
                { id: "session-a", tenantId: "tenant-1" } as never,
                "config-1",
            ),
            service.createEntry(
                { id: "session-b", tenantId: "tenant-1" } as never,
                "config-1",
            ),
        ]);

        const indices = results.map((result) => result.status.status_list.idx);
        expect(new Set(indices).size).toBe(2);

        const lists = await dataSource
            .getRepository(StatusListEntity)
            .findBy({ tenantId: "tenant-1" });
        expect(lists).toHaveLength(2);
    });

    test("concurrent status updates to different indices are both kept", async () => {
        await dataSource
            .getRepository(StatusListEntity)
            .update(
                { id: "list-1", tenantId: "tenant-1" },
                { elements: [0, 0, 0, 0], stack: [2, 3] },
            );
        await dataSource.getRepository(StatusMapping).insert([
            {
                tenantId: "tenant-1",
                sessionId: "x",
                statusListId: "list-1",
                index: 0,
                list: "https://issuer.example/issuers/tenant-1/status-management/status-list/list-1",
                credentialConfigurationId: "config-1",
            },
            {
                tenantId: "tenant-1",
                sessionId: "y",
                statusListId: "list-1",
                index: 1,
                list: "https://issuer.example/issuers/tenant-1/status-management/status-list/list-1",
                credentialConfigurationId: "config-1",
            },
        ]);
        Object.assign(service as object, {
            statusListConfigService: {
                getEffectiveConfig: vi.fn().mockResolvedValue({
                    immediateUpdate: false,
                }),
            },
        });

        await Promise.all([
            service.updateStatus(
                {
                    sessionId: "x",
                    credentialConfigurationId: "config-1",
                    status: 1,
                } as never,
                "tenant-1",
            ),
            service.updateStatus(
                {
                    sessionId: "y",
                    credentialConfigurationId: "config-1",
                    status: 1,
                } as never,
                "tenant-1",
            ),
        ]);

        const list = await dataSource
            .getRepository(StatusListEntity)
            .findOneByOrFail({ id: "list-1", tenantId: "tenant-1" });
        expect(list.elements).toEqual([1, 1, 0, 0]);
    });

    describe("status values wider than a list's bits per entry", () => {
        const mapping = (
            sessionId: string,
            statusListId: string,
            index: number,
            credentialConfigurationId: string,
        ) => ({
            tenantId: "tenant-1",
            sessionId,
            statusListId,
            index,
            list: `https://issuer.example/issuers/tenant-1/status-management/status-list/${statusListId}`,
            credentialConfigurationId,
        });

        const elementsOf = async (id: string) =>
            (
                await dataSource
                    .getRepository(StatusListEntity)
                    .findOneByOrFail({ id, tenantId: "tenant-1" })
            ).elements;

        const signJWT = vi.fn().mockResolvedValue("jwt");

        beforeEach(async () => {
            signJWT.mockClear();
            await dataSource.getRepository(StatusListEntity).save({
                id: "list-2",
                tenantId: "tenant-1",
                credentialConfigurationId: null,
                elements: [0, 0],
                stack: [],
                bits: 2,
            });
            Object.assign(service as object, {
                statusListConfigService: {
                    getEffectiveConfig: vi.fn().mockResolvedValue({
                        immediateUpdate: true,
                        ttl: 300,
                        enableAggregation: false,
                    }),
                },
                certService: {
                    find: vi.fn().mockResolvedValue({
                        keyId: "status-list-key",
                        crt: [],
                    }),
                    getLeafCertBase64: vi.fn().mockReturnValue(["certificate"]),
                },
                keyChainService: { signJWT },
                signStatusListCwt: vi.fn().mockResolvedValue(Uint8Array.of(1)),
            });
        });

        test("rejects a suspension on a 1-bit list without changing any of the session's entries", async () => {
            // The wide list's entry comes first, so writing entry by entry
            // without checking every list up front would change it.
            await dataSource
                .getRepository(StatusMapping)
                .insert([
                    mapping("x", "list-2", 0, "config-wide"),
                    mapping("x", "list-1", 0, "config-narrow"),
                ]);

            await expect(
                service.updateStatus(
                    { sessionId: "x", status: 2 } as never,
                    "tenant-1",
                ),
            ).rejects.toMatchObject({
                status: 400,
                message:
                    "Status 2 (suspended) requires a status list with at least 2 bits per entry; list list-1 uses 1 bit.",
            });

            expect(await elementsOf("list-1")).toEqual([0, 0]);
            expect(await elementsOf("list-2")).toEqual([0, 0]);
            expect(signJWT).not.toHaveBeenCalled();
        });

        test("refuses to reinstate or suspend a revoked credential, changing no entry", async () => {
            await dataSource
                .getRepository(StatusListEntity)
                .update(
                    { id: "list-2", tenantId: "tenant-1" },
                    { elements: [1, 0] },
                );
            // The still valid entry comes first, so writing entry by entry
            // without checking every entry up front would change it.
            await dataSource
                .getRepository(StatusMapping)
                .insert([
                    mapping("x", "list-1", 0, "config-narrow"),
                    mapping("x", "list-2", 0, "config-wide"),
                ]);

            for (const status of [0, 2]) {
                await expect(
                    service.updateStatus(
                        {
                            sessionId: "x",
                            credentialConfigurationId: "config-wide",
                            status,
                        } as never,
                        "tenant-1",
                    ),
                ).rejects.toMatchObject({ status: 409 });
            }
            await expect(
                service.updateStatus(
                    { sessionId: "x", status: 0 } as never,
                    "tenant-1",
                ),
            ).rejects.toMatchObject({
                status: 409,
                message:
                    "A revoked credential cannot be reinstated: revocation is final.",
            });

            expect(await elementsOf("list-1")).toEqual([0, 0]);
            expect(await elementsOf("list-2")).toEqual([1, 0]);
        });

        test("lifts a suspension", async () => {
            await dataSource
                .getRepository(StatusListEntity)
                .update(
                    { id: "list-2", tenantId: "tenant-1" },
                    { elements: [0, 2] },
                );
            await dataSource
                .getRepository(StatusMapping)
                .insert([mapping("x", "list-2", 1, "config-wide")]);

            await service.updateStatus(
                {
                    sessionId: "x",
                    credentialConfigurationId: "config-wide",
                    status: 0,
                } as never,
                "tenant-1",
            );

            expect(await elementsOf("list-2")).toEqual([0, 0]);
        });

        test("stores a suspension on a list with 2 bits per entry", async () => {
            await dataSource
                .getRepository(StatusMapping)
                .insert([
                    mapping("x", "list-2", 1, "config-wide"),
                    mapping("x", "list-1", 0, "config-narrow"),
                ]);

            await service.updateStatus(
                {
                    sessionId: "x",
                    credentialConfigurationId: "config-wide",
                    status: 2,
                } as never,
                "tenant-1",
            );

            expect(await elementsOf("list-2")).toEqual([0, 2]);
            expect(await elementsOf("list-1")).toEqual([0, 0]);
        });

        test("guards the write itself, whichever caller asks for it", async () => {
            const setEntry = (
                service as unknown as {
                    setEntry: (
                        listId: string,
                        index: number,
                        value: number,
                        tenantId: string,
                    ) => Promise<void>;
                }
            ).setEntry.bind(service);

            await expect(
                setEntry("list-1", 1, 2, "tenant-1"),
            ).rejects.toMatchObject({ status: 400 });
            expect(await elementsOf("list-1")).toEqual([0, 0]);
        });

        test("refuses to encode a stored list holding values it cannot represent", async () => {
            await dataSource
                .getRepository(StatusListEntity)
                .update(
                    { id: "list-1", tenantId: "tenant-1" },
                    { elements: [0, 2] },
                );
            const snapshot = await dataSource
                .getRepository(StatusListEntity)
                .findOneByOrFail({ id: "list-1", tenantId: "tenant-1" });

            await expect(service.createListJWT(snapshot)).rejects.toThrow(
                StatusListValuesOutOfRange,
            );
            await expect(service.createListJWT(snapshot)).rejects.toThrow(
                "Status list list-1 stores values that do not fit its 1 bit per entry at index 1.",
            );
            expect(signJWT).not.toHaveBeenCalled();
        });

        test("reads the current status of each of a session's credentials", async () => {
            await dataSource
                .getRepository(StatusListEntity)
                .update(
                    { id: "list-2", tenantId: "tenant-1" },
                    { elements: [2, 1] },
                );
            await dataSource
                .getRepository(StatusMapping)
                .insert([
                    mapping("x", "list-2", 1, "config-wide"),
                    mapping("x", "list-1", 0, "config-narrow"),
                    mapping("x", "list-2", 0, "config-wide"),
                    mapping("y", "list-1", 1, "config-narrow"),
                ]);

            await expect(
                service.getSessionStatus("tenant-1", "x"),
            ).resolves.toEqual([
                {
                    credentialConfigurationId: "config-narrow",
                    statusListId: "list-1",
                    index: 0,
                    status: 0,
                    bits: 1,
                },
                {
                    credentialConfigurationId: "config-wide",
                    statusListId: "list-2",
                    index: 0,
                    status: 2,
                    bits: 2,
                },
                {
                    credentialConfigurationId: "config-wide",
                    statusListId: "list-2",
                    index: 1,
                    status: 1,
                    bits: 2,
                },
            ]);
        });

        test("reads no status for a session without status entries or of another tenant", async () => {
            await dataSource
                .getRepository(StatusMapping)
                .insert(mapping("x", "list-1", 0, "config-narrow"));

            await expect(
                service.getSessionStatus("tenant-1", "unknown"),
            ).resolves.toEqual([]);
            await expect(
                service.getSessionStatus("tenant-2", "x"),
            ).resolves.toEqual([]);
        });

        test("keeps an update that corrects an entry while other entries still prevent publishing", async () => {
            await dataSource
                .getRepository(StatusListEntity)
                .update(
                    { id: "list-1", tenantId: "tenant-1" },
                    { elements: [2, 2] },
                );
            await dataSource
                .getRepository(StatusMapping)
                .insert(mapping("y", "list-1", 1, "config-narrow"));

            await service.updateStatus(
                { sessionId: "y", status: 1 } as never,
                "tenant-1",
            );

            expect(await elementsOf("list-1")).toEqual([2, 1]);
            expect(signJWT).not.toHaveBeenCalled();
        });

        test("reports stored values that do not fit with the sessions they belong to", async () => {
            await dataSource
                .getRepository(StatusListEntity)
                .update(
                    { id: "list-1", tenantId: "tenant-1" },
                    { elements: [0, 2] },
                );
            await dataSource
                .getRepository(StatusListEntity)
                .update(
                    { id: "list-2", tenantId: "tenant-1" },
                    { elements: [2, 3] },
                );
            await dataSource
                .getRepository(StatusMapping)
                .insert(mapping("x", "list-1", 1, "config-narrow"));

            await expect(service.findOutOfRangeEntries()).resolves.toEqual([
                {
                    tenantId: "tenant-1",
                    listId: "list-1",
                    bits: 1,
                    entries: [
                        {
                            index: 1,
                            value: 2,
                            sessionId: "x",
                            credentialConfigurationId: "config-narrow",
                        },
                    ],
                },
            ]);
        });
    });

    test.each([
        0,
        -1,
        1.5,
        MAX_STATUS_LIST_CAPACITY + 1,
        Number.MAX_SAFE_INTEGER,
    ])("rejects capacity %s before allocating the list", async (capacity) => {
        await expect(
            service.createNewList("tenant-1", { capacity }),
        ).rejects.toMatchObject({ status: 400 });
    });
});
