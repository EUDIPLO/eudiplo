import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigService } from "@nestjs/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientsManagedByIdentityProvider } from "../domain/client-data.js";
import { IdpManagedClientsProvider } from "./idp-managed-clients.service.js";

describe("IdpManagedClientsProvider", () => {
    let configFolder: string;
    let provider: IdpManagedClientsProvider;
    /** Client records left from an earlier mode. */
    let stored: Map<string, object>;

    beforeEach(() => {
        configFolder = mkdtempSync(join(tmpdir(), "idp-clients-"));
        stored = new Map();
        provider = new IdpManagedClientsProvider(
            { getOrThrow: () => configFolder } as unknown as ConfigService,
            {
                findOne: async ({ where }: { where: { clientId: string } }) =>
                    stored.get(where.clientId) ?? null,
            } as never,
        );
    });

    afterEach(() => rmSync(configFolder, { recursive: true, force: true }));

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

    it("imports a tenant folder without client files", async () => {
        mkdirSync(join(configFolder, "acme", "clients"), { recursive: true });
        writeFileSync(join(configFolder, "acme", "clients", "README.md"), "");

        await expect(provider.importForTenant("acme")).resolves.toBeUndefined();
        await expect(
            provider.importForTenant("other"),
        ).resolves.toBeUndefined();
    });

    it("fails for client files, which would have no effect", async () => {
        mkdirSync(join(configFolder, "acme", "clients"), { recursive: true });
        writeFileSync(join(configFolder, "acme", "clients", "shop.json"), "{}");

        await expect(provider.importForTenant("acme")).rejects.toThrow(
            `${join(configFolder, "acme", "clients")} contains client files, but with OIDC_PROVIDER=generic clients are managed in the identity provider. Delete the folder, or set OIDC_PROVIDER=keycloak.`,
        );
    });
});
