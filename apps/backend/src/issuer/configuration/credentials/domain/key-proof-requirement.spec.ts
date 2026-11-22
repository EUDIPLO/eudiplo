import { describe, expect, it } from "vitest";
import { requiresKeyProof } from "./key-proof-requirement.js";

describe("requiresKeyProof", () => {
    const sdJwt = (
        keyBinding?: boolean | null,
        keyAttestationsRequired?: object | null,
    ) => ({
        keyBinding,
        config: { format: "dc+sd-jwt", keyAttestationsRequired },
    });

    it("requires a proof for a key-bound SD-JWT VC", () => {
        expect(requiresKeyProof(sdJwt(true))).toBe(true);
    });

    it.each([false, undefined, null])(
        "requires none for an SD-JWT VC with keyBinding %s and no key attestation",
        (keyBinding) => {
            expect(requiresKeyProof(sdJwt(keyBinding))).toBe(false);
        },
    );

    it("keeps requiring a proof when a key attestation is required", () => {
        expect(requiresKeyProof(sdJwt(false, {}))).toBe(true);
        expect(
            requiresKeyProof(sdJwt(false, { key_storage: ["iso_18045_high"] })),
        ).toBe(true);
    });

    it.each([false, undefined, true])(
        "always requires a proof for an mDOC (keyBinding %s)",
        (keyBinding) => {
            expect(
                requiresKeyProof({
                    keyBinding,
                    config: { format: "mso_mdoc" },
                }),
            ).toBe(true);
        },
    );
});
