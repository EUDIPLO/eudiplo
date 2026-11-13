import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { privateJwkProblem } from "./private-jwk.js";

const privateJwk = (namedCurve: string) =>
    generateKeyPairSync("ec", { namedCurve }).privateKey.export({
        format: "jwk",
    });

describe("privateJwkProblem", () => {
    it.each(["P-256", "P-384", "P-521"])(
        "accepts a %s private key",
        (curve) => {
            expect(privateJwkProblem(privateJwk(curve))).toBeUndefined();
        },
    );

    it.each([
        ["null", null],
        ["a string", "key"],
        ["a public key", { ...privateJwk("P-256"), d: undefined }],
        ["an empty d", { ...privateJwk("P-256"), d: "" }],
    ])("reports a missing private key for %s", (_, jwk) => {
        expect(privateJwkProblem(jwk)).toBe("The key has no private key (d).");
    });

    it.each([
        ["another key on the same curve", privateJwk("P-256").d],
        ["a key on another curve", privateJwk("P-384").d],
        ["an unresolved placeholder", "${KEY_D}"],
    ])("reports a d that belongs to %s", (_, d) => {
        expect(privateJwkProblem({ ...privateJwk("P-256"), d })).toBe(
            "The private key (d) is not valid or does not belong to the public key (x, y).",
        );
    });
});
