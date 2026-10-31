import { beforeEach, describe, expect, test, vi } from "vitest";
import { TenantEntity } from "./entities/tenant.entity.js";
import { TenantService } from "./tenant.service.js";

describe("TenantService updates", () => {
    let storedTenant: TenantEntity;
    let repository: {
        getWithClients: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
    };
    let service: TenantService;
    let keyChains: {
        assertAccessKeyChain: ReturnType<typeof vi.fn>;
        getDefaultAccessKeyChain: ReturnType<typeof vi.fn>;
    };
    let auditLog: { record: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        storedTenant = {
            id: "tenant",
            name: "Tenant",
            description: "Existing description",
            status: "active",
            clients: [],
        };
        repository = {
            getWithClients: vi.fn(async () => ({ ...storedTenant })),
            update: vi.fn(async (_criteria, update) => {
                Object.assign(storedTenant, update);
                return { affected: 1 };
            }),
        };

        keyChains = {
            assertAccessKeyChain: vi.fn(async () => undefined),
            getDefaultAccessKeyChain: vi.fn(async () => ({})),
        };
        auditLog = { record: vi.fn(async () => undefined) };
        service = new TenantService(
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            repository as never,
            {
                getUpDownCounter: vi.fn(() => ({ add: vi.fn() })),
            } as never,
            {} as never,
            { registerTenantSetup: vi.fn() } as never,
            auditLog as never,
            {} as never,
            {} as never,
            {} as never,
            keyChains as never,
        );
    });

    test("preserves the existing description when it is omitted", async () => {
        const updated = await service.updateTenant("tenant", {
            name: "Renamed",
        });

        expect(updated.description).toBe("Existing description");
        expect(repository.update).toHaveBeenCalledWith("tenant", {
            name: "Renamed",
        });
    });

    test("replaces an existing description", async () => {
        const updated = await service.updateTenant("tenant", {
            description: "Updated description",
        });

        expect(updated.description).toBe("Updated description");
    });

    test("persists null to clear an existing description", async () => {
        const updated = await service.updateTenant("tenant", {
            description: null,
        });

        expect(updated.description).toBeNull();
        expect(repository.update).toHaveBeenCalledWith("tenant", {
            description: null,
        });
    });

    describe("setDefaultAccessKeyChain", () => {
        const actor = { client: { clientId: "admin" } } as never;
        const meta = {} as never;

        test("checks a new default access key chain before saving it", async () => {
            await service.setDefaultAccessKeyChain(
                "tenant",
                "access",
                actor,
                meta,
            );

            expect(keyChains.assertAccessKeyChain).toHaveBeenCalledWith(
                "tenant",
                "access",
            );
            expect(storedTenant.defaultKeyChains).toEqual({ access: "access" });
        });

        test("saves nothing when the default access key chain is refused", async () => {
            keyChains.assertAccessKeyChain.mockRejectedValueOnce(
                new Error("not an access key chain"),
            );

            await expect(
                service.setDefaultAccessKeyChain(
                    "tenant",
                    "attestation",
                    actor,
                    meta,
                ),
            ).rejects.toThrow("not an access key chain");
            expect(repository.update).not.toHaveBeenCalled();
        });

        test("removes the default access key chain with null without a check", async () => {
            storedTenant.defaultKeyChains = { access: "access" };

            await service.setDefaultAccessKeyChain("tenant", null, actor, meta);

            expect(keyChains.assertAccessKeyChain).not.toHaveBeenCalled();
            expect(storedTenant.defaultKeyChains).toBeNull();
        });

        test("records a changed default access key chain in the audit log", async () => {
            storedTenant.defaultKeyChains = null;

            await service.setDefaultAccessKeyChain(
                "tenant",
                "access",
                actor,
                meta,
            );

            expect(auditLog.record).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: "tenant_updated",
                    changedFields: ["defaultKeyChains"],
                    before: expect.objectContaining({
                        defaultKeyChains: null,
                    }),
                    after: expect.objectContaining({
                        defaultKeyChains: { access: "access" },
                    }),
                }),
            );
        });
    });
});

describe("TenantService setupTenant", () => {
    test.each([String.raw`x\..\victim`, "kms.json"])(
        "skips the folder %j, which is no tenant folder name",
        async (tenantId) => {
            const repository = { findActive: vi.fn() };
            const service = new TenantService(
                {} as never,
                { getOrThrow: vi.fn(() => "/config") } as never,
                {} as never,
                {} as never,
                repository as never,
                {
                    getUpDownCounter: vi.fn(() => ({ add: vi.fn() })),
                } as never,
                {} as never,
                { registerTenantSetup: vi.fn() } as never,
                {} as never,
                {} as never,
                {} as never,
                {} as never,
                {} as never,
            );

            await expect(service.setupTenant(tenantId)).resolves.toBe(false);
            expect(repository.findActive).not.toHaveBeenCalled();
        },
    );
});
