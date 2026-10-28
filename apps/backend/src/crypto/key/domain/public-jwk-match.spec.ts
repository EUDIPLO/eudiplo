import { describe, expect, it } from "vitest";
import { arePublicJwksEquivalent } from "./public-jwk-match.js";

const ec = {
    kty: "EC",
    crv: "P-256",
    x: "pmn8SKQKZ0t2zFlrUXzJaJwwQ0WnQxcSYoS_D6ZSGho",
    y: "rMd9JTAovcOI_OvOXWCWZ1yVZieVYK2UgvB2IPuSk2o",
};

describe("arePublicJwksEquivalent", () => {
    it("matches a private EC JWK with its public JWK, whatever kid and alg say", () => {
        expect(
            arePublicJwksEquivalent(
                { ...ec, d: "secret", kid: "a", alg: "ES256" },
                { ...ec, kid: "b" },
            ),
        ).toBe(true);
    });

    it("tells EC keys apart by a coordinate", () => {
        expect(arePublicJwksEquivalent(ec, { ...ec, y: "other" })).toBe(false);
    });

    it("compares RSA keys by n and e", () => {
        const rsa = { kty: "RSA", n: "modulus", e: "AQAB" };
        expect(arePublicJwksEquivalent(rsa, { ...rsa, d: "secret" })).toBe(
            true,
        );
        expect(arePublicJwksEquivalent(rsa, { ...rsa, n: "other" })).toBe(
            false,
        );
    });

    it("compares OKP keys by crv and x", () => {
        const okp = { kty: "OKP", crv: "Ed25519", x: "key" };
        expect(arePublicJwksEquivalent(okp, { ...okp })).toBe(true);
        expect(arePublicJwksEquivalent(okp, { ...okp, crv: "X25519" })).toBe(
            false,
        );
    });

    it("never matches different or unknown key types", () => {
        expect(
            arePublicJwksEquivalent(ec, { kty: "OKP", crv: "P-256", x: ec.x }),
        ).toBe(false);
        expect(
            arePublicJwksEquivalent(
                { kty: "oct", k: "a" },
                { kty: "oct", k: "a" },
            ),
        ).toBe(false);
    });
});
