import { describe, expect, it } from "vitest";
import {
    type CredentialRequestEncryptionSupport,
    checkCredentialRequestJweHeader,
    InvalidCredentialRequestEncryption,
} from "./credential-request-encryption.js";

const supported: CredentialRequestEncryptionSupport = {
    jwks: { keys: [{ kid: "enc", alg: "ECDH-ES" }] },
    enc_values_supported: ["A128GCM", "A256GCM"],
};

const validHeader = { alg: "ECDH-ES", enc: "A128GCM", kid: "enc" };

/** A compact JWE with the given protected header; the other parts are opaque. */
function jwe(header: Record<string, unknown>): string {
    const encoded = Buffer.from(JSON.stringify(header)).toString("base64url");
    return `${encoded}..iv.ciphertext.tag`;
}

function refusal(
    token: string,
    support: CredentialRequestEncryptionSupport | undefined,
): string {
    try {
        checkCredentialRequestJweHeader(token, support);
    } catch (error) {
        expect(error).toBeInstanceOf(InvalidCredentialRequestEncryption);
        return (error as Error).message;
    }
    throw new Error("expected a refusal");
}

describe("checkCredentialRequestJweHeader", () => {
    it.each(["A128GCM", "A256GCM"])(
        "accepts the advertised key, its alg and enc %s",
        (enc) => {
            expect(() =>
                checkCredentialRequestJweHeader(
                    jwe({ ...validHeader, enc }),
                    supported,
                ),
            ).not.toThrow();
        },
    );

    it("accepts an encrypted key part, as ECDH-ES with key wrapping has", () => {
        const [header, , ...rest] = jwe(validHeader).split(".");
        expect(() =>
            checkCredentialRequestJweHeader(
                [header, "key", ...rest].join("."),
                supported,
            ),
        ).not.toThrow();
    });

    it("refuses any JWE when the issuer advertises no request encryption", () => {
        expect(refusal(jwe(validHeader), undefined)).toBe(
            "Credential request encryption is not supported",
        );
    });

    it.each([
        ["four parts", "a.b.c.d"],
        ["an empty ciphertext", "a..iv..tag"],
        ["characters outside base64url", "a+b..iv.ciphertext.tag"],
    ])("refuses a JWE with %s", (_case, token) => {
        expect(refusal(token, supported)).toBe(
            "Credential request is not a compact JWE",
        );
    });

    it.each([
        ["no JSON", Buffer.from("not json").toString("base64url")],
        ["a JSON array", Buffer.from("[]").toString("base64url")],
    ])("refuses a protected header with %s", (_case, header) => {
        expect(refusal(`${header}..iv.ciphertext.tag`, supported)).toBe(
            "Unable to decode credential request JWE header",
        );
    });

    it.each<[string, Record<string, unknown>]>([
        ["no kid", { alg: "ECDH-ES", enc: "A128GCM" }],
        ["an empty kid", { ...validHeader, kid: "" }],
        ["an unknown kid", { ...validHeader, kid: "unknown" }],
        ["a kid that is not a string", { ...validHeader, kid: 1 }],
    ])("refuses a header with %s", (_case, header) => {
        expect(refusal(jwe(header), supported)).toBe(
            "Credential request is not encrypted to a key advertised by the issuer",
        );
    });

    it.each<[string, Record<string, unknown>]>([
        ["another alg", { ...validHeader, alg: "ECDH-ES+A128KW" }],
        ["no alg", { enc: "A128GCM", kid: "enc" }],
    ])("refuses a header with %s", (_case, header) => {
        expect(refusal(jwe(header), supported)).toBe(
            "Credential request JWE 'alg' must match the advertised key algorithm 'ECDH-ES'",
        );
    });

    it.each<[string, Record<string, unknown>]>([
        ["another enc", { ...validHeader, enc: "A128CBC-HS256" }],
        ["no enc", { alg: "ECDH-ES", kid: "enc" }],
    ])("refuses a header with %s", (_case, header) => {
        expect(refusal(jwe(header), supported)).toBe(
            "Credential request JWE 'enc' must be one of 'A128GCM', 'A256GCM'",
        );
    });

    it("refuses a compressed request", () => {
        expect(refusal(jwe({ ...validHeader, zip: "DEF" }), supported)).toBe(
            "Compressed credential requests are not supported",
        );
    });

    it("refuses a header with crit", () => {
        expect(
            refusal(
                jwe({ ...validHeader, crit: ["x-ext"], "x-ext": true }),
                supported,
            ),
        ).toBe(
            "Credential request JWE must not contain a critical ('crit') header parameter",
        );
    });

    it("checks the key before alg, enc, zip and crit", () => {
        expect(
            refusal(
                jwe({
                    alg: "ECDH-ES+A128KW",
                    enc: "A128CBC-HS256",
                    kid: "unknown",
                    zip: "DEF",
                    crit: ["x-ext"],
                }),
                supported,
            ),
        ).toBe(
            "Credential request is not encrypted to a key advertised by the issuer",
        );
    });
});
