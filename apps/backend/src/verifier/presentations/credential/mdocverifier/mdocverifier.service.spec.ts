import { DeviceResponse, Verifier } from "@owf/mdoc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    shortVerificationMessage,
    type VerificationFailureType,
} from "../verification-failure.js";
import { MdocverifierService } from "./mdocverifier.service.js";

describe("MdocverifierService failure classification", () => {
    let service: MdocverifierService;

    beforeEach(() => {
        const chainValidation = {
            getTrustedCertificateBuffers: vi.fn().mockResolvedValue([]),
        };
        const logger = {
            setContext: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        };

        service = new MdocverifierService(
            chainValidation as any,
            { mdocFetch: vi.fn() } as any,
            logger as any,
        );
    });

    it("maps chain error codes to stable failure types", () => {
        const map = (code?: string) =>
            (service as any).mapChainErrorToFailureType(code);

        expect(map("x5c_required")).toBe("x5c_missing");
        expect(map("chain_build_failed")).toBe("no_trust_chain_to_root");
        expect(map("no_trusted_entity_match")).toBe("trust_chain_not_trusted");
        expect(map("trust_list_unavailable")).toBe("trust_list_unavailable");
        expect(map("certificate_expired")).toBe("certificate_expired");
        expect(map("something_unexpected")).toBe("verification_error");
        expect(map(undefined)).toBe("verification_error");
    });

    it("keeps signature_invalid when chain probe does not fail", async () => {
        vi.spyOn(DeviceResponse, "decode").mockReturnValue({
            documents: [{}],
        } as any);

        vi.spyOn(service as any, "extractErrorDetails").mockResolvedValue({
            docType: "org.iso.18013.5.1.mDL",
            issuerCertInfo: "issuer",
            issuerThumbprint: "thumb",
            issuerValidity: "validity",
            trustedCertsSummary: "none",
        });

        vi.spyOn(
            service as any,
            "validateIssuerCertificateChain",
        ).mockResolvedValue({
            verified: true,
            matchedEntity: null,
        });

        const result = await (service as any).handleVerificationError(
            "AA",
            new Error(
                "Unable to verify deviceAuth signature (ECDSA/EdDSA): Device signature must be valid",
            ),
            {
                trustListSource: { lotes: [] },
                policy: { requireX5c: true },
            },
        );

        expect(result.failureType).toBe("signature_invalid");
    });

    it("overrides signature_invalid with trust-chain failure when probe fails", async () => {
        vi.spyOn(DeviceResponse, "decode").mockReturnValue({
            documents: [{}],
        } as any);

        vi.spyOn(service as any, "extractErrorDetails").mockResolvedValue({
            docType: "org.iso.18013.5.1.mDL",
            issuerCertInfo: "issuer",
            issuerThumbprint: "thumb",
            issuerValidity: "validity",
            trustedCertsSummary: "none",
        });

        vi.spyOn(
            service as any,
            "validateIssuerCertificateChain",
        ).mockResolvedValue({
            verified: false,
            matchedEntity: null,
            error: "chain_build_failed",
            errorDetails: "No issuer chain to trusted root",
        });

        const result = await (service as any).handleVerificationError(
            "AA",
            new Error(
                "Unable to verify deviceAuth signature (ECDSA/EdDSA): Device signature must be valid",
            ),
            {
                trustListSource: { lotes: [] },
                policy: { requireX5c: true },
            },
        );

        expect(result.failureType).toBe("no_trust_chain_to_root");
        expect(result.failureReason).toBe("No issuer chain to trusted root");
    });
});

describe("MdocverifierService revocation mode", () => {
    let service: MdocverifierService;
    let chainValidation: {
        getTrustedCertificateBuffers: ReturnType<typeof vi.fn>;
        getTrustedStatusCertificateBuffers: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        vi.restoreAllMocks();

        chainValidation = {
            getTrustedCertificateBuffers: vi
                .fn()
                .mockResolvedValue([new Uint8Array([1, 2, 3])]),
            getTrustedStatusCertificateBuffers: vi
                .fn()
                .mockResolvedValue([new Uint8Array([4, 5, 6])]),
        };

        const logger = {
            setContext: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            trace: vi.fn(),
        };

        service = new MdocverifierService(
            chainValidation as any,
            { mdocFetch: vi.fn() } as any,
            logger as any,
        );

        vi.spyOn(DeviceResponse, "decode").mockReturnValue({
            documents: [
                {
                    docType: "org.iso.18013.5.1.mDL",
                    issuerSigned: {
                        issuerNamespaces: {
                            issuerNamespaces: new Map<string, unknown>(),
                        },
                        getPrettyClaims: vi.fn().mockReturnValue(undefined),
                        issuerAuth: {
                            x5chain: [new Uint8Array([9, 9, 9])],
                        },
                    },
                },
            ],
        } as any);

        vi.spyOn(
            service as any,
            "validateIssuerCertificateChain",
        ).mockResolvedValue({
            verified: true,
            matchedEntity: null,
        });
    });

    it("retries without status anchors in best-effort mode when status list is unavailable", async () => {
        const verifyDeviceResponse = vi
            .spyOn(Verifier, "verifyDeviceResponse")
            .mockRejectedValueOnce(
                new Error("Status list fetch timed out after 10000ms"),
            )
            .mockResolvedValueOnce(undefined as any);

        const result = await service.verify(
            "AA",
            {
                protocol: "iso-18013-7",
                sessionTranscript: {} as any,
            },
            {
                trustListSource: { lotes: [] },
                policy: {
                    requireX5c: true,
                    revocation: {
                        enabled: true,
                        failClosed: false,
                    },
                },
            } as any,
        );

        expect(result.verified).toBe(true);
        expect(verifyDeviceResponse).toHaveBeenCalledTimes(2);

        const firstCallTrusted = verifyDeviceResponse.mock.calls[0][0]
            .trustedCertificates as Array<Record<string, unknown>>;
        const secondCallTrusted = verifyDeviceResponse.mock.calls[1][0]
            .trustedCertificates as Array<Record<string, unknown>>;
        const firstDisableStatusValidation =
            verifyDeviceResponse.mock.calls[0][0].disableStatusValidation;
        const secondDisableStatusValidation =
            verifyDeviceResponse.mock.calls[1][0].disableStatusValidation;

        expect(firstCallTrusted[0].status).toBeDefined();
        expect(secondCallTrusted[0].status).toBeUndefined();
        expect(firstDisableStatusValidation).toBe(false);
        expect(secondDisableStatusValidation).toBe(true);
    });

    it("does not retry in strict mode when status list is unavailable", async () => {
        const verifyDeviceResponse = vi
            .spyOn(Verifier, "verifyDeviceResponse")
            .mockRejectedValueOnce(
                new Error("Status list fetch timed out after 10000ms"),
            );

        const result = await service.verify(
            "AA",
            {
                protocol: "iso-18013-7",
                sessionTranscript: {} as any,
            },
            {
                trustListSource: { lotes: [] },
                policy: {
                    requireX5c: true,
                    revocation: {
                        enabled: true,
                        failClosed: true,
                    },
                },
            } as any,
        );

        expect(result.verified).toBe(false);
        expect(verifyDeviceResponse).toHaveBeenCalledTimes(1);
    });

    it("passes only trusted issuance anchors to the mdoc library when available", async () => {
        const verifyDeviceResponse = vi
            .spyOn(Verifier, "verifyDeviceResponse")
            .mockResolvedValueOnce(undefined as any);

        await service.verify(
            "AA",
            {
                protocol: "iso-18013-7",
                sessionTranscript: {} as any,
            },
            {
                trustListSource: { lotes: [] },
                policy: {
                    requireX5c: true,
                    revocation: {
                        enabled: true,
                        failClosed: true,
                    },
                },
            } as any,
        );

        const trustedCertificates = verifyDeviceResponse.mock.calls[0][0]
            .trustedCertificates as Array<Record<string, Uint8Array[]>>;
        const disableStatusValidation =
            verifyDeviceResponse.mock.calls[0][0].disableStatusValidation;

        expect(trustedCertificates).toHaveLength(1);
        expect(trustedCertificates[0].issuance).toEqual([
            new Uint8Array([1, 2, 3]),
        ]);
        expect(trustedCertificates[0].status).toEqual([
            new Uint8Array([4, 5, 6]),
        ]);
        expect(disableStatusValidation).toBe(false);
    });

    it("attaches status anchors for mdoc compatibility even when revocation is disabled", async () => {
        const verifyDeviceResponse = vi
            .spyOn(Verifier, "verifyDeviceResponse")
            .mockResolvedValueOnce(undefined as any);

        await service.verify(
            "AA",
            {
                protocol: "iso-18013-7",
                sessionTranscript: {} as any,
            },
            {
                trustListSource: { lotes: [] },
                policy: {
                    requireX5c: true,
                    revocation: {
                        enabled: false,
                        failClosed: false,
                    },
                },
            } as any,
        );

        const trustedCertificates = verifyDeviceResponse.mock.calls[0][0]
            .trustedCertificates as Array<Record<string, Uint8Array[]>>;
        const disableStatusValidation =
            verifyDeviceResponse.mock.calls[0][0].disableStatusValidation;

        expect(trustedCertificates).toHaveLength(1);
        expect(trustedCertificates[0].issuance).toEqual([
            new Uint8Array([1, 2, 3]),
        ]);
        expect(trustedCertificates[0].status).toEqual([
            new Uint8Array([4, 5, 6]),
        ]);
        expect(disableStatusValidation).toBe(true);
    });
});

describe("shortVerificationMessage", () => {
    const failureTypes: VerificationFailureType[] = [
        "signature_invalid",
        "no_trust_chain_to_root",
        "trust_chain_not_trusted",
        "trust_list_unavailable",
        "certificate_expired",
        "x5c_missing",
        "verification_error",
    ];

    it("returns a distinct, non-verbose message for every failure type", () => {
        const messages = failureTypes.map((t) => shortVerificationMessage(t));

        // Every message is present and human-readable.
        expect(messages.every((m) => m.length > 0)).toBe(true);
        // No certificate subjects, thumbprints or list URLs leak into the UI text.
        expect(
            messages.every((m) => !/subject=|thumbprint|https?:\/\//i.test(m)),
        ).toBe(true);
        // Each failure type maps to its own message.
        expect(new Set(messages).size).toBe(failureTypes.length);
    });

    it("falls back to the generic message for an unknown/undefined type", () => {
        expect(shortVerificationMessage(undefined)).toBe(
            "The credential could not be verified.",
        );
        expect(shortVerificationMessage("verification_error")).toBe(
            "The credential could not be verified.",
        );
    });
});

// Regression guard for the case that motivated classifying at the source: the
// untrusted issuer was rejected correctly, but reported as a generic
// verification error, so a relying party could not tell "bad credential" from
// "issuer not on the trust list".
describe("classifyVerificationError", () => {
    const classify = (message: string) =>
        (
            MdocverifierService.prototype as unknown as {
                classifyVerificationError(e: unknown): string;
            }
        ).classifyVerificationError({ message });

    it("classifies an untrusted issuer as a trust failure", () => {
        expect(
            classify(
                'No trusted certificate was found while validating the X.509 chain. chain=[{"subject":"C=DE, CN=Root Tenant"}]',
            ),
        ).toBe("trust_chain_not_trusted");
    });

    it("still classifies signature problems as signature_invalid", () => {
        expect(classify("Device signature must be valid")).toBe(
            "signature_invalid",
        );
    });

    it("leaves a genuinely unrecognised failure generic", () => {
        expect(
            classify("The MSO must be valid at the time of verification"),
        ).toBe("verification_error");
    });
});
