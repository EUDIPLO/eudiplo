import { expect, test } from "vitest";
import { KeyChainIdTokenSigner } from "./key-chain-id-token-signer.js";

test("advertises the algorithm of the key chain that signs", async () => {
    const calls: unknown[] = [];
    const signer = new KeyChainIdTokenSigner({
        resolveAuthorizationServerKeyChain: async () => ({ id: "as" }),
        signJWT: async () => "jwt",
        getAccessTokenVerificationKeys: async () => [],
        getSigningAlg: async (tenantId: string, keyId: string) => {
            calls.push([tenantId, keyId]);
            return "ES384";
        },
    } as never);
    expect(await signer.algorithms("t")).toEqual(["ES384"]);
    expect(calls).toEqual([["t", "as"]]);
});
