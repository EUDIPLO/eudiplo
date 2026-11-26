import "reflect-metadata";
import { DataSource } from "typeorm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ClientEntity } from "../../auth/client/entities/client.entity.js";
import { TenantEntity } from "../../auth/tenant/entities/tenant.entity.js";
import { MAX_STATUS_LIST_CAPACITY } from "../../shared/domain/status-list-capacity.js";
import { StatusListValuesOutOfRange } from "./domain/status-value.js";
import { ActiveCredentialSlot } from "./entities/active-credential-slot.entity.js";
import { StatusListEntity } from "./entities/status-list.entity.js";
import { StatusMapping } from "./entities/status-mapping.entity.js";
import { StatusListService } from "./status-list.service.js";

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

    test.each([0, 1.5, MAX_STATUS_LIST_CAPACITY + 1, Number.MAX_SAFE_INTEGER])(
        "refuses to import a new list with capacity %s before allocating it",
        async (capacity) => {
            await expect(
                service.processStatusListConfig("tenant-1", {
                    id: "list-2",
                    capacity,
                }),
            ).rejects.toMatchObject({ status: 400 });
            expect(
                await dataSource
                    .getRepository(StatusListEntity)
                    .findOneBy({ tenantId: "tenant-1", id: "list-2" }),
            ).toBeNull();
        },
    );

    test("refuses to import a new list sized by an oversized tenant default", async () => {
        await dataSource.getRepository(TenantEntity).update(
            { id: "tenant-1" },
            {
                statusListConfig: {
                    capacity: MAX_STATUS_LIST_CAPACITY + 1,
                },
            },
        );
        await expect(
            service.processStatusListConfig("tenant-1", { id: "list-2" }),
        ).rejects.toMatchObject({ status: 400 });
        expect(
            await dataSource
                .getRepository(StatusListEntity)
                .findOneBy({ tenantId: "tenant-1", id: "list-2" }),
        ).toBeNull();
    });

    test("keeps an allocation made while a binding update was validated", async () => {
        // Allocation writes only `stack` and keeps the version, so it does not
        // conflict with a binding update, and neither write loses the other.
        const repository = dataSource.getRepository(StatusListEntity);
        Object.assign(service, {
            certService: {
                find: async () => {
                    await service.createEntry(
                        { id: "session-1", tenantId: "tenant-1" } as never,
                        "config-1",
                    );
                    return {};
                },
            },
            regenerateListTokens: vi.fn().mockResolvedValue({}),
        });

        await service.updateList("tenant-1", "list-1", {
            keyChainId: "new-key",
        });

        const list = await repository.findOneByOrFail({
            tenantId: "tenant-1",
            id: "list-1",
        });
        expect(list.keyChainId).toBe("new-key");
        expect(list.stack).toHaveLength(1);
        const mappings = await dataSource
            .getRepository(StatusMapping)
            .findBy({ tenantId: "tenant-1", statusListId: "list-1" });
        expect(mappings.map((m) => m.index)).not.toContain(list.stack[0]);
        expect(mappings).toHaveLength(1);
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
        // Allocation does not touch the values, so it keeps the version that
        // guards them and the tokens signed from them.
        expect(list.version).toBe(1);

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
                getLeafCertBase64: vi.fn().mockReturnValue(["MAA="]),
            },
            keyChainService: {
                getSigningAlg: vi.fn().mockResolvedValue("ES256"),
                getPublicKey: vi.fn().mockResolvedValue({ kty: "EC" }),
                signBytes: vi.fn().mockImplementation(async () => {
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
                    return Uint8Array.of(1);
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

    test("keeps tokens signed while an entry was allocated", async () => {
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
                getLeafCertBase64: vi.fn().mockReturnValue(["MAA="]),
            },
            keyChainService: {
                getSigningAlg: vi.fn().mockResolvedValue("ES256"),
                getPublicKey: vi.fn().mockResolvedValue({ kty: "EC" }),
                signBytes: vi.fn().mockImplementation(async () => {
                    await service.createEntry(
                        { id: "session-1", tenantId: "tenant-1" } as never,
                        "config-1",
                    );
                    return Uint8Array.of(1);
                }),
            },
            signStatusListCwt: vi.fn().mockResolvedValue(Uint8Array.of(1)),
        });

        await expect(service.createListJWT(snapshot)).resolves.toBe(true);

        const current = await repository.findOneByOrFail({
            id: snapshot.id,
            tenantId: snapshot.tenantId,
        });
        expect(current.stack).toHaveLength(1);
        expect(current.jwt).toEqual(expect.any(String));
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
                getLeafCertBase64: vi.fn().mockReturnValue(["MAA="]),
            },
            keyChainService: {
                getSigningAlg: vi.fn().mockResolvedValue("ES256"),
                getPublicKey: vi.fn().mockResolvedValue({ kty: "EC" }),
                signBytes: vi.fn().mockResolvedValue(Uint8Array.of(1)),
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

    test("changes no status of a credential configuration outside the caller's limit", async () => {
        await dataSource
            .getRepository(StatusListEntity)
            .update(
                { id: "list-1", tenantId: "tenant-1" },
                { elements: [0, 0, 0, 0], stack: [2, 3] },
            );
        const entry = (index: number, credentialConfigurationId: string) => ({
            tenantId: "tenant-1",
            // No session row: status entries outlive their session.
            sessionId: "cleaned-up-session",
            statusListId: "list-1",
            index,
            list: "https://issuer.example/issuers/tenant-1/status-management/status-list/list-1",
            credentialConfigurationId,
        });
        await dataSource
            .getRepository(StatusMapping)
            .insert([entry(0, "pid"), entry(1, "mdl")]);
        Object.assign(service as object, {
            statusListConfigService: {
                getEffectiveConfig: vi.fn().mockResolvedValue({
                    immediateUpdate: false,
                }),
            },
        });
        const update = (credentialConfigurationId?: string) =>
            ({
                sessionId: "cleaned-up-session",
                credentialConfigurationId,
                status: 1,
            }) as never;
        const elements = async () =>
            (
                await dataSource
                    .getRepository(StatusListEntity)
                    .findOneByOrFail({ id: "list-1", tenantId: "tenant-1" })
            ).elements;

        // The whole session and the other configuration are outside the limit.
        await expect(
            service.updateStatus(update(), "tenant-1", ["pid"]),
        ).rejects.toThrow("No status mapping found");
        await expect(
            service.updateStatus(update("mdl"), "tenant-1", ["pid"]),
        ).rejects.toThrow("No status mapping found");
        expect(await elements()).toEqual([0, 0, 0, 0]);

        await service.updateStatus(update("pid"), "tenant-1", ["pid"]);
        expect(await elements()).toEqual([1, 0, 0, 0]);

        // An empty list is no limit.
        await service.updateStatus(update(), "tenant-1", []);
        expect(await elements()).toEqual([1, 1, 0, 0]);
    });

    describe("reading status lists without their entries", () => {
        /**
         * The SELECT statements the service runs while `action` executes.
         * `elements` and `stack` hold one number per entry, so the hot read
         * paths must not transfer and parse them.
         */
        async function selectsDuring(action: () => Promise<unknown>) {
            const statements: string[] = [];
            const spy = vi
                .spyOn(dataSource.logger, "logQuery")
                .mockImplementation((query: string) => {
                    if (/^\s*SELECT/i.test(query)) statements.push(query);
                });
            try {
                await action();
            } finally {
                spy.mockRestore();
            }
            return statements;
        }

        beforeEach(async () => {
            await dataSource.getRepository(StatusListEntity).update(
                { tenantId: "tenant-1", id: "list-1" },
                {
                    jwt: "cached.status.jwt",
                    cwt: Buffer.from([0xa0]).toString("base64url"),
                    expiresAt: new Date(Date.now() + 3_600_000),
                },
            );
        });

        test("serves a cached JWT without loading the entries", async () => {
            let jwt: string | undefined;
            const statements = await selectsDuring(async () => {
                jwt = await service.getListJwt("tenant-1", "list-1");
            });

            expect(jwt).toBe("cached.status.jwt");
            expect(statements).toHaveLength(1);
            expect(statements[0]).toMatch(/"jwt"/);
            expect(statements[0]).not.toMatch(/"elements"|"stack"/);
        });

        test("serves a cached CWT without loading the entries", async () => {
            let cwt: Uint8Array | undefined;
            const statements = await selectsDuring(async () => {
                cwt = await service.getListCwt("tenant-1", "list-1");
            });

            expect(cwt).toEqual(Uint8Array.from([0xa0]));
            expect(statements).toHaveLength(1);
            expect(statements[0]).toMatch(/"cwt"/);
            expect(statements[0]).not.toMatch(/"elements"|"stack"/);
        });

        test("reports an unknown list as not found", async () => {
            await expect(
                service.getListJwt("tenant-1", "missing"),
            ).rejects.toMatchObject({ status: 404 });
            await expect(
                service.getListCwt("tenant-1", "missing"),
            ).rejects.toMatchObject({ status: 404 });
        });

        test("does not serve a list of another tenant", async () => {
            await dataSource.getRepository(TenantEntity).save({
                id: "tenant-2",
                name: "Tenant 2",
                status: "active",
            });
            await expect(
                service.getListJwt("tenant-2", "list-1"),
            ).rejects.toMatchObject({ status: 404 });
            await expect(
                service.getListCwt("tenant-2", "list-1"),
            ).rejects.toMatchObject({ status: 404 });
        });

        test("lists the URIs in creation order without loading the entries", async () => {
            await dataSource.getRepository(StatusListEntity).save({
                id: "list-0",
                tenantId: "tenant-1",
                credentialConfigurationId: null,
                elements: [0],
                stack: [0],
                bits: 1,
                createdAt: new Date(Date.now() + 60_000),
            });

            let uris: string[] = [];
            const statements = await selectsDuring(async () => {
                uris = await service.getStatusListUris("tenant-1");
            });

            expect(uris).toEqual([
                "https://issuer.example/issuers/tenant-1/status-management/status-list/list-1",
                "https://issuer.example/issuers/tenant-1/status-management/status-list/list-0",
            ]);
            expect(statements).toHaveLength(1);
            expect(statements[0]).toMatch(/"id"/);
            expect(statements[0]).not.toMatch(/"elements"|"stack"/);
        });

        /** Signing fakes, so expired tokens can be regenerated. */
        function fakeSigning() {
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
                    getLeafCertBase64: vi.fn().mockReturnValue(["MAA="]),
                },
                keyChainService: {
                    getSigningAlg: vi.fn().mockResolvedValue("ES256"),
                    getPublicKey: vi.fn().mockResolvedValue({ kty: "EC" }),
                    signBytes: vi.fn().mockResolvedValue(Uint8Array.of(1)),
                },
                signStatusListCwt: vi
                    .fn()
                    .mockResolvedValue(Uint8Array.of(0xb1)),
            });
        }

        test("regenerates an expired JWT instead of serving it", async () => {
            fakeSigning();
            const repository = dataSource.getRepository(StatusListEntity);
            await repository.update(
                { tenantId: "tenant-1", id: "list-1" },
                { expiresAt: new Date(Date.now() - 1000) },
            );

            const jwt = await service.getListJwt("tenant-1", "list-1");

            expect(jwt).not.toBe("cached.status.jwt");
            const list = await repository.findOneByOrFail({
                tenantId: "tenant-1",
                id: "list-1",
            });
            expect(list.jwt).toBe(jwt);
            expect(list.expiresAt!.getTime()).toBeGreaterThan(Date.now());
        });

        test("regenerates a missing CWT instead of failing", async () => {
            fakeSigning();
            await dataSource
                .getRepository(StatusListEntity)
                .update(
                    { tenantId: "tenant-1", id: "list-1" },
                    { cwt: null as never },
                );

            const cwt = await service.getListCwt("tenant-1", "list-1");

            expect(cwt).toEqual(Uint8Array.of(0xb1));
        });

        test("allocates an entry without loading the list's values", async () => {
            let idx: number | undefined;
            const statements = await selectsDuring(async () => {
                const payload = await service.createEntry(
                    { id: "session-1", tenantId: "tenant-1" } as never,
                    "config-1",
                );
                idx = payload.status.status_list.idx;
            });

            const listReads = statements.filter((query) =>
                /FROM "status_list_entity"/.test(query),
            );
            expect(listReads.length).toBeGreaterThan(0);
            for (const query of listReads) {
                expect(query).not.toMatch(/"elements"|"jwt"|"cwt"/);
            }

            // The index comes off the stack; values and tokens stay as they were.
            expect(idx).toBe(1);
            const list = await dataSource
                .getRepository(StatusListEntity)
                .findOneByOrFail({ tenantId: "tenant-1", id: "list-1" });
            expect(list.stack).toEqual([0]);
            expect(list.elements).toEqual([0, 0]);
            expect(list.jwt).toBe("cached.status.jwt");
        });
    });

    describe("deleting a status list", () => {
        const mapping = (sessionId: string, index: number) => ({
            tenantId: "tenant-1",
            sessionId,
            statusListId: "list-1",
            index,
            list: "https://issuer.example/issuers/tenant-1/status-management/status-list/list-1",
            credentialConfigurationId: "pid",
        });

        test("deletes a list no credential uses", async () => {
            await service.deleteList("tenant-1", "list-1");

            expect(
                await dataSource
                    .getRepository(StatusListEntity)
                    .countBy({ tenantId: "tenant-1" }),
            ).toBe(0);
        });

        test.each([
            [1, "1 credential is using it"],
            [2, "2 credentials are using it"],
        ])(
            "refuses a list %i credential(s) use with 409",
            async (count, text) => {
                await dataSource
                    .getRepository(StatusMapping)
                    .save(
                        Array.from({ length: count }, (_, i) =>
                            mapping(`session-${i}`, i),
                        ),
                    );

                await expect(
                    service.deleteList("tenant-1", "list-1"),
                ).rejects.toMatchObject({
                    status: 409,
                    message: `Cannot delete status list list-1: ${text}`,
                });
                expect(
                    await dataSource
                        .getRepository(StatusListEntity)
                        .countBy({ tenantId: "tenant-1" }),
                ).toBe(1);
            },
        );
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

        const signBytes = vi.fn().mockResolvedValue(Uint8Array.of(1));

        beforeEach(async () => {
            signBytes.mockClear();
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
                    getLeafCertBase64: vi.fn().mockReturnValue(["MAA="]),
                },
                keyChainService: {
                    getSigningAlg: vi.fn().mockResolvedValue("ES256"),
                    getPublicKey: vi.fn().mockResolvedValue({ kty: "EC" }),
                    signBytes,
                },
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
            expect(signBytes).not.toHaveBeenCalled();
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
            expect(signBytes).not.toHaveBeenCalled();
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

        test("records when a session's status was last changed", async () => {
            await dataSource
                .getRepository(StatusMapping)
                .insert([
                    mapping("x", "list-2", 0, "config-wide"),
                    mapping("x", "list-1", 0, "config-narrow"),
                    mapping("y", "list-1", 1, "config-narrow"),
                ]);

            const before = Date.now();
            await service.updateStatus(
                { sessionId: "x", status: 1 } as never,
                "tenant-1",
            );
            const after = Date.now();

            const updated = await service.getSessionStatus("tenant-1", "x");
            expect(updated).toHaveLength(2);
            for (const entry of updated) {
                expect(entry.status).toBe(1);
                const at = Date.parse(entry.statusUpdatedAt ?? "");
                expect(at).toBeGreaterThanOrEqual(before - 1000);
                expect(at).toBeLessThanOrEqual(after + 1000);
            }
            const [untouched] = await service.getSessionStatus("tenant-1", "y");
            expect(untouched.statusUpdatedAt).toBeUndefined();
        });

        test("keeps the time of the last change for updates that change nothing or are rejected", async () => {
            await dataSource
                .getRepository(StatusMapping)
                .insert([mapping("x", "list-1", 0, "config-narrow")]);
            const statusUpdatedAt = async () =>
                (await service.getSessionStatus("tenant-1", "x"))[0]
                    .statusUpdatedAt;

            await service.updateStatus(
                { sessionId: "x", status: 0 } as never,
                "tenant-1",
            );
            expect(await statusUpdatedAt()).toBeUndefined();

            vi.useFakeTimers({ toFake: ["Date"] });
            try {
                vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
                await service.updateStatus(
                    { sessionId: "x", status: 1 } as never,
                    "tenant-1",
                );
                vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
                await service.updateStatus(
                    { sessionId: "x", status: 1 } as never,
                    "tenant-1",
                );
            } finally {
                vi.useRealTimers();
            }
            const revokedAt = await statusUpdatedAt();
            expect(revokedAt).toBe("2026-01-01T00:00:00.000Z");

            await expect(
                service.updateStatus(
                    { sessionId: "x", status: 0 } as never,
                    "tenant-1",
                ),
            ).rejects.toMatchObject({ status: 409 });
            expect(await statusUpdatedAt()).toBe(revokedAt);
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
            expect(signBytes).not.toHaveBeenCalled();
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
    describe("revoking a credential configuration's entries", () => {
        const regenerateListTokens = vi.fn().mockResolvedValue(undefined);

        const mapping = (
            tenantId: string,
            sessionId: string,
            statusListId: string,
            index: number,
            credentialConfigurationId: string,
        ) => ({
            tenantId,
            sessionId,
            statusListId,
            index,
            list: `https://issuer.example/issuers/${tenantId}/status-management/status-list/${statusListId}`,
            credentialConfigurationId,
        });

        const listOf = (tenantId: string, id: string) =>
            dataSource
                .getRepository(StatusListEntity)
                .findOneByOrFail({ id, tenantId });

        beforeEach(async () => {
            regenerateListTokens.mockClear();
            Object.assign(service as object, {
                statusListConfigService: {
                    getEffectiveConfig: vi
                        .fn()
                        .mockResolvedValue({ immediateUpdate: true }),
                },
                regenerateListTokens,
            });
            await dataSource.getRepository(TenantEntity).save({
                id: "tenant-2",
                name: "Tenant 2",
                status: "active",
            });
            const lists = dataSource.getRepository(StatusListEntity);
            await lists.update(
                { tenantId: "tenant-1", id: "list-1" },
                { elements: [0, 0, 0, 1], stack: [] },
            );
            await lists.save([
                {
                    id: "list-2",
                    tenantId: "tenant-1",
                    credentialConfigurationId: null,
                    elements: [0, 2],
                    stack: [],
                    bits: 2,
                },
                {
                    id: "list-1",
                    tenantId: "tenant-2",
                    credentialConfigurationId: null,
                    elements: [0, 0],
                    stack: [],
                    bits: 1,
                },
            ]);
            await dataSource
                .getRepository(StatusMapping)
                .insert([
                    mapping("tenant-1", "a", "list-1", 0, "pid"),
                    mapping("tenant-1", "b", "list-1", 1, "mdl"),
                    mapping("tenant-1", "c", "list-1", 2, "pid"),
                    mapping("tenant-1", "d", "list-1", 3, "pid"),
                    mapping("tenant-1", "e", "list-2", 1, "pid"),
                    mapping("tenant-2", "f", "list-1", 0, "pid"),
                ]);
        });

        test("revokes only the tenant's entries of the configuration, once per list", async () => {
            const revoked = await service.revokeCredentialConfigurationEntries(
                "tenant-1",
                "pid",
            );

            // Index 3 of list-1 was revoked already; index 1 of list-2 was
            // suspended and is revoked now.
            expect(revoked).toBe(3);
            expect((await listOf("tenant-1", "list-1")).elements).toEqual([
                1, 0, 1, 1,
            ]);
            expect((await listOf("tenant-1", "list-2")).elements).toEqual([
                0, 1,
            ]);
            expect((await listOf("tenant-2", "list-1")).elements).toEqual([
                0, 0,
            ]);
            expect(regenerateListTokens).toHaveBeenCalledTimes(2);

            const updated = await dataSource.getRepository(StatusMapping).find({
                where: { tenantId: "tenant-1" },
                order: { sessionId: "ASC" },
            });
            expect(
                updated.map((entry) => [
                    entry.sessionId,
                    entry.statusUpdatedAt instanceof Date,
                ]),
            ).toEqual([
                ["a", true],
                ["b", false],
                ["c", true],
                ["d", false],
                ["e", true],
            ]);
        });

        test("finishes a call whose publication failed when it is repeated", async () => {
            regenerateListTokens.mockImplementation(
                async (_tenantId: string, listId: string) => {
                    if (listId === "list-2") throw new Error("signer down");
                },
            );
            await expect(
                service.revokeCredentialConfigurationEntries("tenant-1", "pid"),
            ).rejects.toThrow("signer down");
            expect((await listOf("tenant-1", "list-1")).elements).toEqual([
                1, 0, 1, 1,
            ]);

            regenerateListTokens.mockReset();
            regenerateListTokens.mockResolvedValue(undefined);
            // Everything is revoked by now; the lists are published anyway.
            expect(
                await service.revokeCredentialConfigurationEntries(
                    "tenant-1",
                    "pid",
                ),
            ).toBe(0);
            expect(
                regenerateListTokens.mock.calls.map(([, listId]) => listId),
            ).toEqual(expect.arrayContaining(["list-1", "list-2"]));
        });

        test("leaves publication to the list's TTL without immediate updates", async () => {
            Object.assign(service as object, {
                statusListConfigService: {
                    getEffectiveConfig: vi
                        .fn()
                        .mockResolvedValue({ immediateUpdate: false }),
                },
            });
            expect(
                await service.revokeCredentialConfigurationEntries(
                    "tenant-1",
                    "pid",
                ),
            ).toBe(3);
            expect(regenerateListTokens).not.toHaveBeenCalled();
        });

        test("revokes nothing for a configuration without entries", async () => {
            expect(
                await service.revokeCredentialConfigurationEntries(
                    "tenant-1",
                    "unknown",
                ),
            ).toBe(0);
            expect((await listOf("tenant-1", "list-1")).elements).toEqual([
                0, 0, 0, 1,
            ]);
        });
    });
});
