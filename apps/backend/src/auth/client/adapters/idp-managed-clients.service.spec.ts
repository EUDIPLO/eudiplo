import { beforeEach, describe, expect, it } from "vitest";
import { ClientsManagedByIdentityProvider } from "../domain/client-data.js";
import { IdpManagedClientsProvider } from "./idp-managed-clients.service.js";

describe("IdpManagedClientsProvider", () => {
    let provider: IdpManagedClientsProvider;
    /** Client records left from an earlier mode. */
    let stored: Map<string, object>;

    beforeEach(() => {
        stored = new Map();
        provider = new IdpManagedClientsProvider({
            findOne: async ({ where }: { where: { clientId: string } }) =>
                stored.get(where.clientId) ?? null,
        } as never);
    });

    it("gives tokens of unknown clients no resource limits", async () => {
        await expect(provider.getClientById("shop")).resolves.toBeNull();
    });

    it("keeps the limits and the tenant of a client created in an earlier mode", async () => {
        stored.set("shop", {
            clientId: "shop",
            tenantId: "acme",
            roles: ["issuance:offer"],
            allowedIssuanceConfigs: ["loyalty-card"],
            secret: "hash",
        });

        await expect(provider.getClientById("shop")).resolves.toEqual({
            clientId: "shop",
            description: undefined,
            tenantId: "acme",
            roles: ["issuance:offer"],
            allowedIssuanceConfigs: ["loyalty-card"],
            allowedPresentationConfigs: undefined,
        });
    });

    it.each([
        ["getClients", () => provider.getClients("acme")],
        ["getClient", () => provider.getClient("acme", "shop")],
        ["getClientRoles", () => provider.getClientRoles("acme", "shop")],
        [
            "addClient",
            () => provider.addClient("acme", { clientId: "shop" } as never),
        ],
        ["updateClient", () => provider.updateClient("acme", "shop", {})],
        [
            "rotateClientSecret",
            () => provider.rotateClientSecret("acme", "shop"),
        ],
        [
            "setClientSecret",
            () => provider.setClientSecret("acme", "shop", "s"),
        ],
        ["removeClient", () => provider.removeClient("acme", "shop")],
        ["assertCanCreateClients", () => provider.assertCanCreateClients()],
    ])("refuses %s", (_, call) => {
        expect(call).toThrow(ClientsManagedByIdentityProvider);
    });
});
