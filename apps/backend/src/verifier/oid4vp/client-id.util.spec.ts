import { describe, expect, it, vi } from "vitest";
import type { CertificateInfo } from "../../crypto/key/cert/cert.service.js";
import { createClientId } from "./client-id.util.js";
import { ClientIdScheme } from "./dto/presentation-request.dto.js";

const cert = {} as CertificateInfo;

describe("createClientId", () => {
    it("uses x509_hash by default", () => {
        const certService = {
            getCertHash: vi.fn().mockReturnValue("certificate-hash"),
            getCertDnsName: vi.fn(),
        };

        expect(createClientId(cert, certService)).toBe(
            "x509_hash:certificate-hash",
        );
        expect(certService.getCertDnsName).not.toHaveBeenCalled();
    });

    it("uses the certificate DNS SAN when requested", () => {
        const certService = {
            getCertHash: vi.fn(),
            getCertDnsName: vi.fn().mockReturnValue("verifier.example.com"),
        };

        expect(
            createClientId(cert, certService, ClientIdScheme.X509_SAN_DNS),
        ).toBe("x509_san_dns:verifier.example.com");
        expect(certService.getCertHash).not.toHaveBeenCalled();
    });
});
