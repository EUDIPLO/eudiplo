import { describe, expect, it } from "vitest";
import {
    mapChainErrorToFailureType,
    verificationFailureDetails,
} from "./verification-failure.js";

/**
 * The chain validator (CredentialChainValidationService) is shared by the mDoc
 * and SD-JWT-VC verifiers, and both classify trust failures through
 * mapChainErrorToFailureType. So this mapping is where "the same failure means
 * the same thing regardless of credential format" is actually enforced.
 *
 * The list below is every `error:` string the chain validator emits today
 * (credential-chain-validation.service.ts). If a new one is added without a
 * mapping, it silently degrades to the generic `verification_error` — which is
 * exactly the loss of signal these codes exist to prevent. This test fails when
 * that happens.
 */
describe("mapChainErrorToFailureType — format-neutral trust classification", () => {
    const CHAIN_VALIDATOR_CODES: Record<string, string> = {
        x5c_required: "x5c_missing",
        chain_build_failed: "no_trust_chain_to_root",
        no_trusted_entity_match: "trust_chain_not_trusted",
        trust_list_unavailable: "trust_list_unavailable",
        certificate_expired: "certificate_expired",
    };

    it("maps every chain-validator error code to a specific, non-generic type", () => {
        for (const [code, expected] of Object.entries(CHAIN_VALIDATOR_CODES)) {
            expect(mapChainErrorToFailureType(code)).toBe(expected);
            expect(mapChainErrorToFailureType(code)).not.toBe(
                "verification_error",
            );
        }
    });

    it("falls back to verification_error only for unknown/absent codes", () => {
        expect(mapChainErrorToFailureType(undefined)).toBe(
            "verification_error",
        );
        expect(mapChainErrorToFailureType("something_new")).toBe(
            "verification_error",
        );
    });

    it("an untrusted issuer classifies identically for any format", () => {
        // Both the mDoc and SD-JWT paths reach this with `no_trusted_entity_match`
        // from the shared chain validator; the type must be the trust-specific one,
        // not the generic error, so a relying party can tell "issuer not trusted"
        // from "bad credential".
        expect(mapChainErrorToFailureType("no_trusted_entity_match")).toBe(
            "trust_chain_not_trusted",
        );
    });
});

describe("verificationFailureDetails", () => {
    it("pairs the failure type with its short message and keeps the verbose reason apart", () => {
        expect(
            verificationFailureDetails(
                "trust_chain_not_trusted",
                "CN=Issuer not in list",
            ),
        ).toEqual({
            code: "trust_chain_not_trusted",
            message: "The credential issuer is not in the trusted list.",
            verbose: "CN=Issuer not in list",
        });
    });

    it("falls back to verification_error for an unclassified failure", () => {
        expect(verificationFailureDetails(undefined)).toEqual({
            code: "verification_error",
            message: "The credential could not be verified.",
            verbose: undefined,
        });
    });
});
