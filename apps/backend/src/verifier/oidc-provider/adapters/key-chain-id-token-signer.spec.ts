import { expect, test } from "vitest";
import { KeyChainIdTokenSigner } from "./key-chain-id-token-signer.js";

function signer(keys: Record<string, unknown>[]) {
    return new KeyChainIdTokenSigner({
        resolveAuthorizationServerKeyChain: async () => ({ id: "as" }),
        signJWT: async () => "jwt",
        getAccessTokenVerificationKeys: async () => keys,
    } as never);
}

test("advertises the algorithms of the published keys", async () => {
    expect(
        await signer([{ crv: "P-384" }, { crv: "P-256" }]).algorithms("t"),
    ).toEqual(["ES384", "ES256"]);
    expect(
        await signer([{ alg: "ES512", crv: "P-521" }]).algorithms("t"),
    ).toEqual(["ES512"]);
    expect(await signer([]).algorithms("t")).toEqual(["ES256"]);
});
