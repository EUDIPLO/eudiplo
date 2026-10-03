import { describe, expect, it, vi } from "vitest";
import { WellKnownService } from "./well-known.service.js";

function wellKnown(issuanceConfig: object) {
    return Object.assign(Object.create(WellKnownService.prototype), {
        issuanceService: {
            getIssuanceConfiguration: vi.fn().mockResolvedValue(issuanceConfig),
        },
        keyChainService: {
            getKid: vi.fn().mockResolvedValue("default-key"),
            getPublicKey: vi.fn(async (_format, _tenant, keyId: string) => ({
                kty: "EC",
                x: keyId,
            })),
        },
    }) as WellKnownService;
}

describe("WellKnownService JWKS of the built-in authorization server", () => {
    it("publishes the key the built-in server signs access tokens with", async () => {
        await expect(
            wellKnown({
                signingKeyId: "issuance-key",
                authorizationServers: [
                    {
                        type: "built-in",
                        id: "built-in",
                        token: { signingKeyId: "as-key" },
                    },
                ],
            }).getJwks("tenant-1"),
        ).resolves.toEqual({
            keys: [{ kty: "EC", x: "as-key", kid: "as-key" }],
        });
    });

    it("falls back to the issuance key, then the tenant default", async () => {
        await expect(
            wellKnown({
                signingKeyId: "issuance-key",
                authorizationServers: [{ type: "built-in", id: "built-in" }],
            }).getJwks("tenant-1"),
        ).resolves.toEqual({
            keys: [{ kty: "EC", x: "issuance-key", kid: "issuance-key" }],
        });
        await expect(
            wellKnown({ authorizationServers: [] }).getJwks("tenant-1"),
        ).resolves.toEqual({
            keys: [{ kty: "EC", x: "default-key", kid: "default-key" }],
        });
    });
});
