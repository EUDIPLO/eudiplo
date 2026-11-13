import { describe, expect, it } from "vitest";
import {
    assertCertificateChainLength,
    CertificateChainTooLong,
    MAX_CERTIFICATE_CHAIN_LENGTH,
} from "./certificate-chain-length.util.js";

describe("assertCertificateChainLength", () => {
    it("allows ten certificates", () => {
        expect(MAX_CERTIFICATE_CHAIN_LENGTH).toBe(10);
        expect(() =>
            assertCertificateChainLength(new Array(10).fill("cert")),
        ).not.toThrow();
    });

    it("refuses eleven certificates, naming the header and both numbers", () => {
        const refuse = () =>
            assertCertificateChainLength(new Array(11).fill("cert"));

        expect(refuse).toThrow(CertificateChainTooLong);
        expect(refuse).toThrow(
            "x5c holds 11 certificates; at most 10 are accepted",
        );
    });

    it("leaves a value that is not an array to the caller", () => {
        expect(() =>
            assertCertificateChainLength("M".repeat(50) as unknown as string[]),
        ).not.toThrow();
    });

    it("names x5chain for a COSE chain", () => {
        expect(() =>
            assertCertificateChainLength(
                new Array(12).fill(new Uint8Array()),
                "x5chain",
            ),
        ).toThrow("x5chain holds 12 certificates; at most 10 are accepted");
    });
});
