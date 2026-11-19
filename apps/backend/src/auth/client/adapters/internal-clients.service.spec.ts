import * as bcrypt from "bcrypt";
import { describe, expect, it, vi } from "vitest";
import { ClientIdTaken } from "../domain/client-data.js";
import { InternalClientsProvider } from "./internal-clients.service.js";

function provider(existing?: {
    clientId: string;
    roles: string[];
    tenantId?: string | null;
    secret?: string;
    tokensValidAfter?: Date | null;
}) {
    const repo = {
        findOneBy: vi.fn().mockResolvedValue(existing ?? null),
        findOneByOrFail: vi.fn().mockResolvedValue(existing),
        countBy: vi.fn().mockResolvedValue(existing ? 1 : 0),
        save: vi.fn((entity) => Promise.resolve(entity)),
        update: vi.fn().mockResolvedValue(undefined),
    };
    return {
        repo,
        clients: Object.assign(
            Object.create(InternalClientsProvider.prototype),
            { repo },
        ) as InternalClientsProvider,
    };
}

describe("InternalClientsProvider", () => {
    it("returns the roles of a client of the tenant", async () => {
        const { clients, repo } = provider({
            clientId: "app",
            roles: ["issuance:offer"],
        });

        await expect(
            clients.getClientRoles("tenant-1", "app"),
        ).resolves.toEqual(["issuance:offer"]);
        expect(repo.findOneBy).toHaveBeenCalledWith({
            clientId: "app",
            tenant: { id: "tenant-1" },
        });
    });

    it("returns nothing for a client the tenant does not have", async () => {
        await expect(
            provider().clients.getClientRoles("tenant-1", "app"),
        ).resolves.toBeUndefined();
    });

    it("reports the roles of the client of the tenant that a create replaces", async () => {
        const { clients, repo } = provider({
            clientId: "app",
            roles: ["issuance:offer"],
        });

        await expect(
            clients.getReplacedClientRoles("tenant-1", "app"),
        ).resolves.toEqual(["issuance:offer"]);
        expect(repo.findOneBy).toHaveBeenCalledWith({
            clientId: "app",
            tenant: { id: "tenant-1" },
        });
    });

    it("refuses the ID of the root client instead of overwriting it", async () => {
        const { clients, repo } = provider({
            clientId: "root",
            roles: ["tenants:manage"],
            tenantId: null,
        });

        await expect(
            clients.addClient("tenant-1", {
                clientId: "root",
                roles: ["issuance:offer" as never],
            }),
        ).rejects.toBeInstanceOf(ClientIdTaken);
        expect(repo.findOneBy).toHaveBeenCalledWith({ clientId: "root" });
        expect(repo.save).not.toHaveBeenCalled();
    });

    it("refuses the ID of another tenant's client", async () => {
        const { clients, repo } = provider({
            clientId: "app",
            roles: ["issuance:offer"],
            tenantId: "tenant-2",
        });

        await expect(
            clients.addClient("tenant-1", {
                clientId: "app",
                roles: ["issuance:offer" as never],
            }),
        ).rejects.toBeInstanceOf(ClientIdTaken);
        expect(repo.save).not.toHaveBeenCalled();
    });

    it("replaces a client of the same tenant, as when a tenant is created again", async () => {
        const { clients, repo } = provider({
            clientId: "tenant-1-admin",
            roles: ["clients:manage"],
            tenantId: "tenant-1",
        });

        const created = await clients.addClient("tenant-1", {
            clientId: "tenant-1-admin",
            roles: ["clients:manage" as never, "issuance:manage" as never],
        });

        expect(repo.save).toHaveBeenCalled();
        expect(created.clientSecret).toBeTruthy();
    });

    describe("clients from before 10.0, without tokensValidAfter", () => {
        async function legacyClient() {
            return provider({
                clientId: "app",
                roles: ["issuance:offer"],
                tenantId: "tenant-1",
                secret: await bcrypt.hash("kept", 4),
                tokensValidAfter: null,
            });
        }

        it("keeps their tokens when stored again with the same secret", async () => {
            const { clients, repo } = await legacyClient();

            await clients.addClient(
                "tenant-1",
                { clientId: "app", roles: ["issuance:offer" as never] },
                "kept",
            );
            await clients.setClientSecret("tenant-1", "app", "kept");

            expect(repo.save.mock.calls[0][0].tokensValidAfter).toBeUndefined();
            expect(repo.update).not.toHaveBeenCalled();
        });

        it("ends their tokens when the secret changes", async () => {
            const { clients, repo } = await legacyClient();

            await clients.addClient(
                "tenant-1",
                { clientId: "app", roles: ["issuance:offer" as never] },
                "changed",
            );
            await clients.setClientSecret("tenant-1", "app", "changed");

            expect(repo.save.mock.calls[0][0].tokensValidAfter).toBeInstanceOf(
                Date,
            );
            expect(
                repo.update.mock.calls[0][1].tokensValidAfter,
            ).toBeInstanceOf(Date);
        });
    });
});
