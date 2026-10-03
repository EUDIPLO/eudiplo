import { describe, expect, it, vi } from "vitest";
import { Oid4vciSdkFactory } from "./oid4vci-sdk.factory.js";

function factory(issuanceConfig: object | Error) {
    const keyChainService = {
        getKid: vi.fn().mockResolvedValue("default-key"),
        getPublicKey: vi.fn(async (_format, _tenant, keyId: string) => ({
            kty: "EC",
            kid: keyId,
        })),
    };
    const sdk = new Oid4vciSdkFactory(
        { keyChainService } as any,
        {
            getIssuanceConfiguration: vi.fn(async () => {
                if (issuanceConfig instanceof Error) throw issuanceConfig;
                return issuanceConfig;
            }),
        } as any,
    );
    const resolveLocalJwks = (jwksUri: string) =>
        (sdk as any).resolveLocalJwks("tenant-1", jwksUri);
    return { resolveLocalJwks, keyChainService };
}

const LOCAL_JWKS =
    "https://issuer.example/.well-known/jwks.json/issuers/tenant-1";

describe("Oid4vciSdkFactory local JWKS", () => {
    it("publishes the access token key of the built-in authorization server", async () => {
        const { resolveLocalJwks } = factory({
            signingKeyId: "issuance-key",
            authorizationServers: [
                {
                    type: "built-in",
                    id: "built-in",
                    token: { signingKeyId: "as-key" },
                },
            ],
        });

        await expect(resolveLocalJwks(LOCAL_JWKS)).resolves.toEqual({
            keys: [{ kty: "EC", kid: "as-key" }],
        });
    });

    it("falls back to the issuance key and the tenant default", async () => {
        await expect(
            factory({
                signingKeyId: "issuance-key",
                authorizationServers: [{ type: "built-in", id: "built-in" }],
            }).resolveLocalJwks(LOCAL_JWKS),
        ).resolves.toEqual({ keys: [{ kty: "EC", kid: "issuance-key" }] });
        await expect(
            factory(new Error("not configured")).resolveLocalJwks(LOCAL_JWKS),
        ).resolves.toEqual({ keys: [{ kty: "EC", kid: "default-key" }] });
    });

    it("leaves foreign JWKS URIs to the library", async () => {
        await expect(
            factory({}).resolveLocalJwks("https://external.example/jwks"),
        ).resolves.toBeUndefined();
    });
});
