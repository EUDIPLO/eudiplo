import type { Jwk } from "@openid4vc/oauth2";
import { describe, expect, it } from "vitest";
import { InvalidCredentialProof } from "./credential-proof-errors.js";
import {
    assertKeyAttestationRequirements,
    type VerifiedCredentialProof,
} from "./key-attestation-requirements.js";

const holderKey: Jwk = { kty: "EC", crv: "P-256", x: "x1", y: "y1" };
const otherKey: Jwk = { kty: "EC", crv: "P-256", x: "x2", y: "y2" };

function attested(
    keyStorage?: string[],
    userAuthentication?: string[],
    attestedKeys: Jwk[] = [holderKey],
): VerifiedCredentialProof {
    return {
        holderKeys: [holderKey],
        keyAttestation: { attestedKeys, keyStorage, userAuthentication },
    };
}

describe("assertKeyAttestationRequirements", () => {
    it("accepts any proof when no key attestation is required", () => {
        expect(() =>
            assertKeyAttestationRequirements(undefined, {
                holderKeys: [holderKey],
            }),
        ).not.toThrow();
    });

    it("requires a key attestation for an empty requirement object", () => {
        expect(() =>
            assertKeyAttestationRequirements({}, { holderKeys: [holderKey] }),
        ).toThrow(InvalidCredentialProof);
        expect(() =>
            assertKeyAttestationRequirements({}, attested()),
        ).not.toThrow();
    });

    it("requires every proven key to be attested", () => {
        expect(() =>
            assertKeyAttestationRequirements(
                {},
                attested(undefined, undefined, [otherKey]),
            ),
        ).toThrow(/attested_keys/);
        expect(() =>
            assertKeyAttestationRequirements(
                {},
                {
                    holderKeys: [],
                    keyAttestation: { attestedKeys: [holderKey] },
                },
            ),
        ).toThrow(InvalidCredentialProof);
    });

    it("compares keys by their public members only", () => {
        expect(() =>
            assertKeyAttestationRequirements(
                {},
                attested(undefined, undefined, [
                    { ...holderKey, kid: "attested", alg: "ES256" },
                ]),
            ),
        ).not.toThrow();
    });

    it("requires one accepted value for each constrained claim", () => {
        const requirements = {
            key_storage: ["iso_18045_high", "iso_18045_moderate"],
            user_authentication: ["iso_18045_high"],
        };
        expect(() =>
            assertKeyAttestationRequirements(
                requirements,
                attested(["iso_18045_moderate"], ["iso_18045_high"]),
            ),
        ).not.toThrow();
        expect(() =>
            assertKeyAttestationRequirements(
                requirements,
                attested(["iso_18045_basic"], ["iso_18045_high"]),
            ),
        ).toThrow(/key_storage/);
        expect(() =>
            assertKeyAttestationRequirements(
                requirements,
                attested(["iso_18045_high"], ["iso_18045_moderate"]),
            ),
        ).toThrow(/user_authentication/);
        expect(() =>
            assertKeyAttestationRequirements(
                requirements,
                attested(undefined, ["iso_18045_high"]),
            ),
        ).toThrow(/key_storage/);
    });

    it("treats empty value lists as unconstrained", () => {
        expect(() =>
            assertKeyAttestationRequirements(
                { key_storage: [], user_authentication: [] },
                attested(),
            ),
        ).not.toThrow();
    });
});
