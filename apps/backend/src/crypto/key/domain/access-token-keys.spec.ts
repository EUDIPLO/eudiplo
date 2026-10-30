import { describe, expect, it } from "vitest";
import {
    accessTokenKeyChainUsageRefusal,
    accessTokenVerificationKeys,
} from "./access-token-keys.js";

const active = { kty: "EC", crv: "P-256", x: "a", y: "a", d: "a", kid: "new" };
const previous = {
    kty: "EC",
    crv: "P-256",
    x: "b",
    y: "b",
    d: "b",
    kid: "old",
};
const rotatedAt = new Date("2026-10-30T12:00:00Z");

describe("accessTokenVerificationKeys", () => {
    it("publishes the previous key while a token it signed can be valid", () => {
        const keys = accessTokenVerificationKeys(
            {
                id: "chain",
                activeJwk: active,
                previousJwk: previous,
                lastRotatedAt: rotatedAt,
            },
            300,
            new Date(rotatedAt.getTime() + 299_000),
        );

        expect(keys.map((key) => key.kid)).toEqual(["new", "old"]);
        // Only public members reach the JWKS.
        expect(keys.every((key) => !("d" in key))).toBe(true);
    });

    it("drops the previous key once the token lifetime has passed", () => {
        const keys = accessTokenVerificationKeys(
            {
                id: "chain",
                activeJwk: active,
                previousJwk: previous,
                lastRotatedAt: rotatedAt,
            },
            300,
            new Date(rotatedAt.getTime() + 300_000),
        );

        expect(keys.map((key) => key.kid)).toEqual(["new"]);
    });

    it("gives a key without kid the key chain ID", () => {
        const { kid: _, ...withoutKid } = active;

        expect(
            accessTokenVerificationKeys(
                { id: "chain", activeJwk: withoutKid },
                300,
            ),
        ).toEqual([{ kty: "EC", crv: "P-256", x: "a", y: "a", kid: "chain" }]);
    });
});

describe("accessTokenKeyChainUsageRefusal", () => {
    it("accepts only the usage type accessToken", () => {
        expect(
            accessTokenKeyChainUsageRefusal("t", "accessToken"),
        ).toBeUndefined();
        expect(accessTokenKeyChainUsageRefusal("t", "access")).toContain(
            'needs a key chain with usage type "accessToken"',
        );
    });
});
