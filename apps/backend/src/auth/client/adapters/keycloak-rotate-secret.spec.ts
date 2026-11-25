import { ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ClientEntity } from "../entities/client.entity.js";
import { KeycloakClientsProvider } from "./keycloak-clients.service.js";

function provider({
    mirror,
    kcClient,
}: {
    mirror?: Partial<ClientEntity>;
    kcClient?: { id: string; attributes?: Record<string, unknown> };
}) {
    const kc = {
        clients: {
            find: vi.fn().mockResolvedValue(kcClient ? [kcClient] : []),
            generateNewClientSecret: vi
                .fn()
                .mockResolvedValue({ value: "new-secret" }),
        },
    };
    const clientRepo = {
        findOneBy: vi.fn().mockResolvedValue(mirror ?? null),
    };
    const settings: Record<string, string> = {
        OIDC_CLIENT_ID: "eudiplo-admin",
        AUTH_CLIENT_ID: "eudiplo-root",
    };
    const configService = { get: vi.fn((key: string) => settings[key]) };
    return {
        kc,
        clients: Object.assign(
            Object.create(KeycloakClientsProvider.prototype),
            { kc, clientRepo, configService },
        ) as KeycloakClientsProvider,
    };
}

describe("KeycloakClientsProvider.rotateClientSecret", () => {
    it("rotates a tenant's client for a tenant manager", async () => {
        const { clients, kc } = provider({
            mirror: { clientId: "app", tenantId: "tenant-1" },
            kcClient: { id: "kc-app", attributes: { tenant_id: ["tenant-1"] } },
        });

        await expect(clients.rotateClientSecret(null, "app")).resolves.toBe(
            "new-secret",
        );
        expect(kc.clients.generateNewClientSecret).toHaveBeenCalledWith({
            id: "kc-app",
        });
    });

    it("rotates its own tenant's client for a tenant caller", async () => {
        const { clients, kc } = provider({
            mirror: { clientId: "app", tenantId: "tenant-1" },
            kcClient: { id: "kc-app", attributes: { tenant_id: ["tenant-1"] } },
        });

        await expect(
            clients.rotateClientSecret("tenant-1", "app"),
        ).resolves.toBe("new-secret");
        expect(kc.clients.generateNewClientSecret).toHaveBeenCalledWith({
            id: "kc-app",
        });
    });

    it("answers 404 when Keycloak no longer has the mirrored client", async () => {
        const { clients, kc } = provider({
            mirror: { clientId: "app", tenantId: "tenant-1" },
        });

        await expect(
            clients.rotateClientSecret(null, "app"),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(kc.clients.generateNewClientSecret).not.toHaveBeenCalled();
    });

    it.each([null, "tenant-1"])(
        "refuses the instance's own clients (tenant %s)",
        async (tenantId) => {
            for (const clientId of ["eudiplo-admin", "eudiplo-root"]) {
                const { clients, kc } = provider({
                    mirror: { clientId, tenantId: "tenant-1" },
                    kcClient: { id: `kc-${clientId}` },
                });
                await expect(
                    clients.rotateClientSecret(tenantId, clientId),
                ).rejects.toBeInstanceOf(NotFoundException);
                expect(kc.clients.find).not.toHaveBeenCalled();
                expect(
                    kc.clients.generateNewClientSecret,
                ).not.toHaveBeenCalled();
            }
        },
    );

    it("does not reach a realm client EUDIPLO does not manage", async () => {
        const { clients, kc } = provider({
            kcClient: { id: "kc-other-app" },
        });

        await expect(
            clients.rotateClientSecret(null, "other-app"),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(kc.clients.find).not.toHaveBeenCalled();
        expect(kc.clients.generateNewClientSecret).not.toHaveBeenCalled();
    });

    it("does not rotate a mirrored client without a tenant", async () => {
        const { clients, kc } = provider({
            mirror: { clientId: "operator", tenantId: undefined },
            kcClient: { id: "kc-operator" },
        });

        await expect(
            clients.rotateClientSecret(null, "operator"),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(kc.clients.generateNewClientSecret).not.toHaveBeenCalled();
    });

    it("does not rotate another tenant's client for a tenant caller", async () => {
        const { clients, kc } = provider({
            mirror: { clientId: "app", tenantId: "tenant-2" },
            kcClient: { id: "kc-app", attributes: { tenant_id: "tenant-2" } },
        });

        await expect(
            clients.rotateClientSecret("tenant-1", "app"),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(kc.clients.generateNewClientSecret).not.toHaveBeenCalled();
    });

    it("refuses when Keycloak names another owner than the mirror", async () => {
        const { clients, kc } = provider({
            mirror: { clientId: "app", tenantId: "tenant-1" },
            kcClient: { id: "kc-app", attributes: { tenant_id: "tenant-2" } },
        });

        await expect(
            clients.rotateClientSecret(null, "app"),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(kc.clients.generateNewClientSecret).not.toHaveBeenCalled();
    });
});
