import type { Oauth2AuthorizationServer } from "@openid4vc/oauth2";
import { describe, expect, it, vi } from "vitest";
import type { Oid4vciSettings } from "../../oid4vci-settings.js";
import { BuildBuiltInAuthorizationServerMetadata } from "./build-built-in-authorization-server-metadata.js";

function metadata(authorizationServers: object[]) {
    return new BuildBuiltInAuthorizationServerMetadata(
        {
            issuanceConfiguration: vi
                .fn()
                .mockResolvedValue({ authorizationServers }),
            statusListAggregationEnabled: vi.fn().mockResolvedValue(false),
            sessionTtlSeconds: vi.fn().mockResolvedValue(3600),
        } as any,
        {
            forTenant: () =>
                ({
                    createAuthorizationServerMetadata: (value: unknown) =>
                        value,
                }) as unknown as Oauth2AuthorizationServer,
        },
        { publicUrl: "https://issuer.example" } as Oid4vciSettings,
    ).execute("tenant-1");
}

describe("BuildBuiltInAuthorizationServerMetadata", () => {
    it("advertises the refresh_token grant and DPoP algorithms by default", async () => {
        await expect(
            metadata([
                // Token settings of other servers do not apply to the built-in one.
                {
                    type: "oid4vp",
                    id: "pid-auth",
                    token: { refreshTokenEnabled: false },
                },
                { type: "built-in", id: "built-in", requireDPoP: true },
            ]),
        ).resolves.toMatchObject({
            grant_types_supported: [
                "authorization_code",
                "refresh_token",
                "urn:ietf:params:oauth:grant-type:pre-authorized_code",
            ],
            dpop_signing_alg_values_supported: ["ES256", "ES384", "ES512"],
        });
    });

    it("omits the refresh_token grant when the built-in server disables it", async () => {
        await expect(
            metadata([
                {
                    type: "built-in",
                    id: "built-in",
                    token: { refreshTokenEnabled: false },
                },
            ]),
        ).resolves.toMatchObject({
            grant_types_supported: [
                "authorization_code",
                "urn:ietf:params:oauth:grant-type:pre-authorized_code",
            ],
        });
    });
});
