import { ForbiddenException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Role } from "../roles/role.enum.js";
import type { TokenPayload } from "../token.decorator.js";
import { ClientController } from "./client.controller.js";
import type { ClientsProvider } from "./client.provider.js";
import { ClientAccessService } from "./client-access.service.js";
import { ClientIdTaken } from "./domain/client-data.js";

const caller: TokenPayload = {
    roles: [Role.Clients, Role.IssuanceOffer],
    entity: { id: "tenant-1" } as TokenPayload["entity"],
};

describe("ClientController.createClient", () => {
    let clients: {
        assertCanCreateClients: ReturnType<typeof vi.fn>;
        getClientById: ReturnType<typeof vi.fn>;
        getReplacedClientRoles: ReturnType<typeof vi.fn>;
        addClient: ReturnType<typeof vi.fn>;
    };
    let controller: ClientController;

    beforeEach(() => {
        clients = {
            assertCanCreateClients: vi.fn(),
            getClientById: vi.fn().mockResolvedValue(null),
            getReplacedClientRoles: vi.fn().mockResolvedValue(undefined),
            addClient: vi.fn().mockResolvedValue({}),
        };
        const provider = clients as unknown as ClientsProvider;
        controller = new ClientController(
            provider,
            new ClientAccessService(provider),
        );
    });

    const dto = { clientId: "app", roles: [Role.IssuanceOffer] };

    it("creates a new client", async () => {
        await controller.createClient(dto, caller);

        expect(clients.getReplacedClientRoles).toHaveBeenCalledWith(
            "tenant-1",
            "app",
        );
        expect(clients.addClient).toHaveBeenCalledWith("tenant-1", dto);
    });

    it("answers that the ID is taken before it looks for a client to take over", async () => {
        clients.getClientById.mockResolvedValue({ clientId: "app" });

        await expect(
            controller.createClient(dto, caller),
        ).rejects.toBeInstanceOf(ClientIdTaken);
        expect(clients.getReplacedClientRoles).not.toHaveBeenCalled();
        expect(clients.addClient).not.toHaveBeenCalled();
    });

    it("takes over a Keycloak client of the tenant whose roles the caller holds", async () => {
        clients.getReplacedClientRoles.mockResolvedValue([
            Role.IssuanceOffer,
            Role.Clients,
        ]);

        await controller.createClient(dto, caller);

        expect(clients.addClient).toHaveBeenCalledWith("tenant-1", dto);
    });

    it("takes over a Keycloak client of the tenant without roles", async () => {
        clients.getReplacedClientRoles.mockResolvedValue([]);

        await controller.createClient(dto, caller);

        expect(clients.addClient).toHaveBeenCalledWith("tenant-1", dto);
    });

    it.each([
        ["an EUDIPLO role", Role.TenantAdmin],
        ["a realm-management role", "realm-management/realm-admin"],
    ])(
        "refuses to take over a Keycloak client of the tenant with %s the caller lacks",
        async (_name, role) => {
            clients.getReplacedClientRoles.mockResolvedValue([
                Role.IssuanceOffer,
                role,
            ]);

            await expect(
                controller.createClient(dto, caller),
            ).rejects.toBeInstanceOf(ForbiddenException);
            expect(clients.addClient).not.toHaveBeenCalled();
        },
    );
});
