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
    let keyChains: { assertAccessKeyChain: ReturnType<typeof vi.fn> };
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

        keyChains = { assertAccessKeyChain: vi.fn(async () => undefined) };
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

    test("checks a new default access key chain before saving it", async () => {
        await service.updateTenant("tenant", {
            defaultAccessKeyChainId: "access",
        });

        expect(keyChains.assertAccessKeyChain).toHaveBeenCalledWith(
            "tenant",
            "access",
        );
        expect(storedTenant.defaultAccessKeyChainId).toBe("access");
    });

    test("saves nothing when the default access key chain is refused", async () => {
        keyChains.assertAccessKeyChain.mockRejectedValueOnce(
            new Error("not an access key chain"),
        );

        await expect(
            service.updateTenant("tenant", {
                defaultAccessKeyChainId: "attestation",
            }),
        ).rejects.toThrow("not an access key chain");
        expect(repository.update).not.toHaveBeenCalled();
    });

    test("removes the default access key chain with null without a check", async () => {
        storedTenant.defaultAccessKeyChainId = "access";

        await service.updateTenant("tenant", {
            defaultAccessKeyChainId: null,
        });

        expect(keyChains.assertAccessKeyChain).not.toHaveBeenCalled();
        expect(storedTenant.defaultAccessKeyChainId).toBeNull();
    });

    test("records a changed default access key chain in the audit log", async () => {
        storedTenant.defaultAccessKeyChainId = null;

        await service.updateTenant(
            "tenant",
            { defaultAccessKeyChainId: "access" },
            { client: { clientId: "admin" } } as never,
        );

        expect(auditLog.record).toHaveBeenCalledWith(
            expect.objectContaining({
                actionType: "tenant_updated",
                changedFields: ["defaultAccessKeyChainId"],
                before: expect.objectContaining({
                    defaultAccessKeyChainId: null,
                }),
                after: expect.objectContaining({
                    defaultAccessKeyChainId: "access",
                }),
            }),
        );
    });

    describe("default access key chain of info.json", () => {
        const pending = () =>
            (
                service as unknown as {
                    pendingDefaultAccessKeyChains: Map<string, string>;
                }
            ).pendingDefaultAccessKeyChains;

        test("does nothing without a pending default", async () => {
            await service.finishTenantSetup("tenant");

            expect(keyChains.assertAccessKeyChain).not.toHaveBeenCalled();
            expect(repository.update).not.toHaveBeenCalled();
        });

        test("applies a pending default once its key chain is imported", async () => {
            pending().set("tenant", "access");

            await service.finishTenantSetup("tenant");

            expect(keyChains.assertAccessKeyChain).toHaveBeenCalledWith(
                "tenant",
                "access",
            );
            expect(storedTenant.defaultAccessKeyChainId).toBe("access");
            expect(pending().has("tenant")).toBe(false);
        });

        test("refuses a pending default that names no access key chain and keeps the stored one", async () => {
            storedTenant.defaultAccessKeyChainId = "previous";
            pending().set("tenant", "attestation");
            keyChains.assertAccessKeyChain.mockRejectedValueOnce(
                new Error(
                    'Key chain "attestation" has usage type "attestation"',
                ),
            );

            await expect(service.finishTenantSetup("tenant")).rejects.toThrow(
                /^defaultAccessKeyChainId in info.json is not applied: Key chain "attestation"/,
            );
            expect(repository.update).not.toHaveBeenCalled();
            expect(storedTenant.defaultAccessKeyChainId).toBe("previous");
        });
    });
});
