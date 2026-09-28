import { describe, expect, it } from "vitest";
import type {
    IssuanceConfiguration,
    ManagedAuthorizationServerData,
} from "../../../configuration/issuance/domain/issuance-configuration.js";
import { AuthorizationServerNotConfigured } from "../domain/authorization-server-errors.js";
import { SelectAuthorizationServer } from "./select-authorization-server.js";

const base = "https://issuer.example/issuers/tenant";

function select(servers: Array<Record<string, unknown>>) {
    return new SelectAuthorizationServer(
        {
            getForTenant: async () =>
                ({
                    authorizationServers:
                        servers as unknown as ManagedAuthorizationServerData[],
                }) as IssuanceConfiguration,
        },
        "https://issuer.example",
    );
}

describe("SelectAuthorizationServer", () => {
    it("uses the first enabled server that can be advertised", async () => {
        await expect(
            select([
                {
                    type: "external",
                    id: "off",
                    issuer: "https://x",
                    enabled: false,
                },
                { type: "chained", id: "incomplete" },
                { type: "oid4vp", id: "vp" },
            ]).execute("tenant"),
        ).resolves.toEqual({
            issuer: `${base}/authorization-servers/vp`,
            // The session keeps the first enabled entry's id.
            sessionServerId: "incomplete",
        });
    });

    it.each([
        [{ type: "built-in", id: "b" }, base],
        [
            { type: "external", id: "e", issuer: "https://as.example" },
            "https://as.example",
        ],
        [
            { type: "chained", id: "c", upstream: { issuer: "u" } },
            `${base}/chained-as`,
        ],
        [
            { type: "chained", id: "c", vp: { enabled: true } },
            `${base}/chained-as-vp`,
        ],
    ])("resolves an explicit selection of %o", async (server, issuer) => {
        await expect(
            select([{ type: "built-in", id: "other" }, server]).execute(
                "tenant",
                server.id,
            ),
        ).resolves.toEqual({ issuer, sessionServerId: issuer });
    });

    it("rejects an unknown, disabled or incomplete selection", async () => {
        const servers = [
            { type: "built-in", id: "off", enabled: false },
            { type: "chained", id: "incomplete" },
        ];
        for (const id of ["missing", "off", "incomplete"]) {
            await expect(select(servers).execute("tenant", id)).rejects.toThrow(
                new AuthorizationServerNotConfigured(
                    `Authorization server '${id}' is not configured or enabled`,
                ),
            );
        }
    });

    it("rejects a configuration without an advertisable server", async () => {
        await expect(
            select([{ type: "chained", id: "c" }]).execute("tenant"),
        ).rejects.toThrow("No enabled authorization server configured");
    });
});
