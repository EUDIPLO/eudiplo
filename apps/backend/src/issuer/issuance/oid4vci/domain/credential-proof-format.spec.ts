import { describe, expect, it } from "vitest";
import { findMalformedKeyProof } from "./credential-proof-format.js";

const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
const header = part({ alg: "ES256", typ: "openid4vci-proof+jwt" });
const payload = part({ nonce: "n" });
const signed = `${header}.${payload}.c2ln`;

describe("findMalformedKeyProof", () => {
    it.each([
        [
            "an unsecured JWT (alg none, empty signature)",
            `${part({ alg: "none" })}.${payload}.`,
        ],
        ["a JWT with two parts", `${header}.${payload}`],
        ["a value that is not a JWT", "not-a-jwt"],
        ["a part that is not base64url", `${header}.${payload}.c2ln+`],
        ["a value that is not a string", 42],
    ])("finds %s among jwt proofs", (_name, proof) => {
        expect(
            findMalformedKeyProof({ proofs: { jwt: [signed, proof] } }),
        ).toBe("jwt");
    });

    it("finds a malformed attestation proof", () => {
        expect(
            findMalformedKeyProof({ proofs: { attestation: ["a.b."] } }),
        ).toBe("attestation");
    });

    it("finds a malformed proof in the single proof of earlier drafts", () => {
        expect(
            findMalformedKeyProof({
                proof: { proof_type: "jwt", jwt: "a.b." },
            }),
        ).toBe("jwt");
        expect(
            findMalformedKeyProof({
                proof: { proof_type: "attestation", attestation: "a.b." },
            }),
        ).toBe("attestation");
    });

    it.each([
        [
            "a single proof of another proof type",
            { proof: { proof_type: "di_vp", jwt: "a.b." } },
        ],
        ["signed proofs", { proofs: { jwt: [signed] } }],
        ["no proofs", { credential_configuration_id: "pid" }],
        ["an unknown proof type", { proofs: { di_vp: ["a.b."] } }],
        ["proofs that are not an array", { proofs: { jwt: "a.b." } }],
        ["a body that is not an object", "body"],
    ])("finds nothing for %s", (_name, body) => {
        expect(findMalformedKeyProof(body)).toBeUndefined();
    });
});
