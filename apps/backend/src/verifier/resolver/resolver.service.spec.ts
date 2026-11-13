import { describe, expect, it } from "vitest";
import {
    chainBelow,
    chainCa,
} from "../../../test/trust/certificate-chain.fixture.js";
import { ResolverService } from "./resolver.service.js";

describe("ResolverService.resolvePublicKey", () => {
    const resolver = new ResolverService();

    it("returns the key of the first certificate of x5c", async () => {
        const { x5c, signingKeys } = await chainBelow(await chainCa(), 10);

        await expect(
            resolver.resolvePublicKey({ kty: "EC", x5c }),
        ).resolves.toMatchObject(
            await crypto.subtle
                .exportKey("jwk", signingKeys.publicKey)
                .then(({ kty, crv, x, y }) => ({ kty, crv, x, y })),
        );
    });

    // The chain check reads the other certificates, and refuses an x5c
    // that is too long before it does.
    it("reads only the first certificate", async () => {
        const { x5c, signingKeys } = await chainBelow(await chainCa(), 1);
        const { kty, crv, x, y } = await crypto.subtle.exportKey(
            "jwk",
            signingKeys.publicKey,
        );

        await expect(
            resolver.resolvePublicKey({
                kty: "EC",
                x5c: [...x5c, ...new Array(20).fill("not a certificate")],
            }),
        ).resolves.toMatchObject({ kty, crv, x, y });
    });
});
