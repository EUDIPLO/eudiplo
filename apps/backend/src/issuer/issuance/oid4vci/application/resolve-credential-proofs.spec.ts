import { describe, expect, it } from "vitest";
import {
    CredentialProofResolutionError,
    ResolveCredentialProofs,
} from "./resolve-credential-proofs.js";

describe("ResolveCredentialProofs", () => {
    const useCase = new ResolveCredentialProofs();
    const required = { required: true };

    it.each([
        ["no proofs", undefined],
        ["valid proofs", { jwt: ["jwt-1"] }],
        ["mixed proof types", { jwt: ["jwt"], attestation: ["attestation"] }],
        ["unsupported proofs", { sd_jwt: ["unsupported"] }],
    ])(
        "ignores %s when the configuration needs no key proof",
        (_label, proofs) => {
            expect(
                useCase.execute(proofs, { required: false }),
            ).toBeUndefined();
        },
    );

    it("selects JWT proofs", () => {
        expect(useCase.execute({ jwt: ["jwt-1", "jwt-2"] }, required)).toEqual({
            proofType: "jwt",
            values: ["jwt-1", "jwt-2"],
        });
    });

    it("selects exactly one attestation proof", () => {
        expect(
            useCase.execute({ attestation: ["attestation-1"] }, required),
        ).toEqual({
            proofType: "attestation",
            values: ["attestation-1"],
        });
    });

    it("rejects mixed proof types", () => {
        expect(() =>
            useCase.execute(
                { jwt: ["jwt"], attestation: ["attestation"] },
                required,
            ),
        ).toThrow(
            "Credential request must include exactly one supported proof type (jwt or attestation)",
        );
    });

    it("rejects multiple attestations", () => {
        expect(() =>
            useCase.execute({ attestation: ["one", "two"] }, required),
        ).toThrow(
            "Attestation proof type requires exactly one key attestation JWT",
        );
    });

    it.each([
        ["missing", undefined],
        ["unsupported", { sd_jwt: ["unsupported"] }],
    ])("rejects %s proofs with the existing description", (_label, proofs) => {
        let thrown: unknown;
        try {
            useCase.execute(proofs, required);
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(CredentialProofResolutionError);
        expect(thrown).toMatchObject({
            message:
                "The proofs parameter is missing or does not contain supported proof types (jwt, attestation)",
        });
    });
});
