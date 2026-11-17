import { describe, expect, test } from "vitest";
import type { OidcClient } from "./domain/oidc-client.js";
import { InvalidOidcClient, OidcClientService } from "./oidc-client.service.js";

function service(options: {
    subjectKey?: Uint8Array;
    unusable?: (configId: string, subjectId?: string) => string | undefined;
}) {
    const stored = new Map<string, OidcClient>();
    const saves: OidcClient[] = [];
    const clients = {
        listForTenant: async () => [...stored.values()],
        findForTenant: async (_tenantId: string, id: string) =>
            stored.get(id) ?? null,
        existsForTenant: async () => stored.size > 0,
        save: async (client: OidcClient) => {
            saves.push(client);
            stored.set(client.id, client);
            return client;
        },
        deleteForTenant: async () => undefined,
        recordSecretUse: async () => undefined,
    };
    const presentations = {
        unusableReason: async (
            _tenantId: string,
            configId: string,
            subjectId?: string,
        ) => options.unusable?.(configId, subjectId),
    };
    return {
        saves,
        service: new OidcClientService(
            clients,
            presentations,
            { record: async () => undefined } as never,
            { subjectKey: options.subjectKey },
        ),
    };
}

const input = {
    name: "Portal",
    redirectUris: ["https://rp.example.com/cb"],
    profile: "secure" as const,
    scopes: [{ scope: "pid", presentationConfigId: "trusted" }],
};
const subject = {
    credentialId: "pid",
    claim: "personal_administrative_number",
};

describe("OidcClientService", () => {
    test("refuses a subject without MASTER_SECRET before saving", async () => {
        const { service: clients, saves } = service({});
        await expect(
            clients.create("t", { ...input, subject }),
        ).rejects.toThrow(InvalidOidcClient);
        await expect(
            clients.create("t", { ...input, subject }),
        ).rejects.toThrow("MASTER_SECRET");
        expect(saves).toHaveLength(0);
    });

    test("checks every scope against the subject, also when only the scopes change", async () => {
        const { service: clients } = service({
            subjectKey: new Uint8Array(32),
            unusable: (configId, subjectId) =>
                subjectId && configId === "open"
                    ? "no trusted_authorities"
                    : undefined,
        });
        const { client } = await clients.create("t", { ...input, subject });
        const scopes = [
            { scope: "pid", presentationConfigId: "trusted" },
            { scope: "other", presentationConfigId: "open" },
        ];
        await expect(
            clients.update("t", client.id, { scopes }),
        ).rejects.toThrow("no trusted_authorities");
        // Without the subject, the same scopes are fine.
        await expect(
            clients.update("t", client.id, { scopes, subject: null }),
        ).resolves.toMatchObject({ subject: null });
    });
});
