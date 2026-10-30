import { describe, expect, it, vi } from "vitest";
import { WellKnownService } from "./well-known.service.js";

function wellKnown(issuanceConfig: object) {
    const keyChainService = {
        getAccessTokenVerificationKeys: vi.fn(
            async (_tenant, keyId: string | undefined) => [
                { kty: "EC", kid: keyId ?? "access-token" },
            ],
        ),
    };
    const service = Object.assign(Object.create(WellKnownService.prototype), {
        issuanceService: {
            getIssuanceConfiguration: vi.fn().mockResolvedValue(issuanceConfig),
        },
        keyChainService,
    }) as WellKnownService;
    return { service, keyChainService };
}

describe("WellKnownService JWKS of the built-in authorization server", () => {
    it("publishes the keys of the key chain the built-in server names", async () => {
        const { service, keyChainService } = wellKnown({
            authorizationServers: [
                {
                    type: "built-in",
                    id: "built-in",
                    token: { signingKeyId: "as-key", lifetimeSeconds: 900 },
                },
            ],
        });

        await expect(service.getJwks("tenant-1")).resolves.toEqual({
            keys: [{ kty: "EC", kid: "as-key" }],
        });
        expect(
            keyChainService.getAccessTokenVerificationKeys,
        ).toHaveBeenCalledWith("tenant-1", "as-key", 900);
    });

    it("falls back to the tenant's access token key chain", async () => {
        const { service, keyChainService } = wellKnown({
            authorizationServers: [{ type: "built-in", id: "built-in" }],
        });

        await expect(service.getJwks("tenant-1")).resolves.toEqual({
            keys: [{ kty: "EC", kid: "access-token" }],
        });
        expect(
            keyChainService.getAccessTokenVerificationKeys,
        ).toHaveBeenCalledWith("tenant-1", undefined, 300);
    });
});
