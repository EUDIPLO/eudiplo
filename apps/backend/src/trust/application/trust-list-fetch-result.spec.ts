import { describe, expect, it } from "vitest";
import { TooManyTrustListCertificatesError } from "../domain/trust-list-certificate-limit.js";
import {
    TrustFetchStatusError,
    TrustListFetchError,
    TrustListVerificationError,
} from "../domain/trust-list-load-errors.js";
import { discardOutcome, failureReason } from "./trust-list-fetch-result.js";

describe("trust list fetch results", () => {
    it.each([
        [{ list: "a", nextUpdate: null }, "outdated"],
        [
            { list: "a", nextUpdate: "x", sequence: { number: "1" } },
            "invalidSequenceNumber",
        ],
        [
            {
                list: "a",
                nextUpdate: "x",
                sequence: { number: 1, highestAccepted: 2 },
            },
            "superseded",
        ],
    ] as const)("classifies a discarded list %j as %s", (entry, outcome) => {
        expect(discardOutcome(entry)).toBe(outcome);
    });

    it("names the HTTP status of a list URL", () => {
        expect(
            failureReason(
                new TrustListFetchError("Failed to fetch trust list", {
                    cause: new TrustFetchStatusError(404),
                }),
            ),
        ).toEqual({
            outcome: "failed",
            reason: "The list URL answered with HTTP status 404",
        });
    });

    it("does not describe network errors, which could probe the network behind the URL policy", () => {
        const { reason } = failureReason(
            new TrustListFetchError(
                "Failed to fetch trust list from https://x: connect ECONNREFUSED 10.0.0.1:443",
                { cause: new Error("connect ECONNREFUSED 10.0.0.1:443") },
            ),
        );
        expect(reason).not.toMatch(/ECONNREFUSED|10\.0\.0\.1/);
    });

    it("keeps the verifier's message without the list URL", () => {
        expect(
            failureReason(
                new TrustListVerificationError(
                    "Trust list JWT verification failed for https://x: signature verification failed",
                    "signature verification failed",
                ),
            ).reason,
        ).toBe(
            "The signature could not be verified: signature verification failed",
        );
    });

    it("passes on the certificate limit and hides other errors", () => {
        expect(
            failureReason(new TooManyTrustListCertificatesError("a", 1001)),
        ).toMatchObject({ outcome: "tooManyCertificates" });
        expect(
            failureReason(new TypeError("secret detail")).reason,
        ).not.toMatch(/secret/);
    });
});
