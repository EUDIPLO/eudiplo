import { describe, expect, it } from "vitest";
import {
    CredentialProofResolutionError,
    ResolveCredentialProofs,
} from "./resolve-credential-proofs.js";

describe("ResolveCredentialProofs", () => {
    const useCase = new ResolveCredentialProofs();

    it("selects JWT proofs", () => {
        expect(useCase.execute({ jwt: ["jwt-1", "jwt-2"] })).toEqual({
            proofType: "jwt",
            values: ["jwt-1", "jwt-2"],
        });
    });

    it("selects exactly one attestation proof", () => {
        expect(useCase.execute({ attestation: ["attestation-1"] })).toEqual({
            proofType: "attestation",
            values: ["attestation-1"],
        });
    });

    it("rejects mixed proof types", () => {
        expect(() =>
            useCase.execute({ jwt: ["jwt"], attestation: ["attestation"] }),
        ).toThrow(
            "Credential request must include exactly one supported proof type (jwt or attestation)",
        );
    });

    it("rejects multiple attestations", () => {
        expect(() => useCase.execute({ attestation: ["one", "two"] })).toThrow(
            "Attestation proof type requires exactly one key attestation JWT",
        );
    });

    it("rejects missing or unsupported proofs with the existing description", () => {
        try {
            useCase.execute({ sd_jwt: ["unsupported"] });
        } catch (error) {
            expect(error).toBeInstanceOf(CredentialProofResolutionError);
            expect(error).toMatchObject({
                message:
                    "The proofs parameter is missing or does not contain supported proof types (jwt, attestation)",
            });
        }
    });
});
