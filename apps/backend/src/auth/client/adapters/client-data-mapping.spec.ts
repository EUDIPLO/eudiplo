import { describe, expect, it, vi } from "vitest";
import { InternalClientsProvider } from "./internal-clients.service.js";
import { KeycloakClientsProvider } from "./keycloak-clients.service.js";

const persistedClient = {
    clientId: "client-1",
    tenantId: undefined,
    description: "Tenant client",
    roles: ["clients:manage"],
    allowedPresentationConfigs: ["pid"],
    allowedIssuanceConfigs: ["pid-credential"],
    secret: "hashed-secret-must-not-leak",
    tenant: { id: "relation-must-not-leak" },
};

describe.each([
    ["internal", InternalClientsProvider],
    ["keycloak mirror", KeycloakClientsProvider],
])("%s client adapter mapping", (_name, Provider) => {
    it("returns tenant-scoped ClientData without persistence fields", async () => {
        const provider = Object.assign(Object.create(Provider.prototype), {
            repo: {
                find: vi.fn().mockResolvedValue([persistedClient]),
                findOneByOrFail: vi.fn().mockResolvedValue(persistedClient),
                findOne: vi.fn().mockResolvedValue(persistedClient),
            },
            clientRepo: {
                find: vi.fn().mockResolvedValue([persistedClient]),
                findOneByOrFail: vi.fn().mockResolvedValue(persistedClient),
                findOne: vi.fn().mockResolvedValue(persistedClient),
            },
        });

        const list = await provider.getClients("tenant-1");
        const detail = await provider.getClient("tenant-1", "client-1");
        const byId = await provider.getClientById("client-1");
        const expected = {
            clientId: "client-1",
            tenantId: "tenant-1",
            description: "Tenant client",
            roles: ["clients:manage"],
            allowedPresentationConfigs: ["pid"],
            allowedIssuanceConfigs: ["pid-credential"],
        };

        expect(list).toEqual([expected]);
        expect(detail).toEqual(expected);
        expect(byId).toEqual({ ...expected, tenantId: undefined });
        expect(list[0]).not.toHaveProperty("secret");
        expect(list[0]).not.toHaveProperty("tenant");
    });
});
