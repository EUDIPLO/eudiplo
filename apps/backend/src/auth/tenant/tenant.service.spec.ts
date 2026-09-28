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
            {} as never,
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
});
