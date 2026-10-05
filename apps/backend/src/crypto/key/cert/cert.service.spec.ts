import { readFileSync } from "node:fs";
import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { CertificateInfo } from "./cert.service.js";
import { CertService } from "./cert.service.js";

const CERT_WITH_DNS_SAN = `-----BEGIN CERTIFICATE-----
MIIBbDCCARKgAwIBAgIJAOOoODRto2cKMAoGCCqGSM49BAMCMB8xHTAbBgNVBAMM
FHZlcmlmaWVyLmV4YW1wbGUuY29tMB4XDTI2MDkyMjEwNDM1MFoXDTM2MDkxOTEw
NDM1MFowHzEdMBsGA1UEAwwUdmVyaWZpZXIuZXhhbXBsZS5jb20wWTATBgcqhkjO
PQIBBggqhkjOPQMBBwNCAAT1AqdckLj7o4uelHb+626saovJ7d+vv6WoEl1u3Tas
HuyyRvx0Vu8gGGqzDlbe83jTF/1olt+Cb/guGQ0L59WwozcwNTAzBgNVHREELDAq
ghR2ZXJpZmllci5leGFtcGxlLmNvbYISYmFja3VwLmV4YW1wbGUuY29tMAoGCCqG
SM49BAMCA0gAMEUCIGtziyKJrWj8lXvunU/rLcNalJ6f1i4sTwBg6L9kP9acAiEA
rC7lqxI8o1f4AhtcHBjqYl+BeJC1FC9vWw69QjwkbaM=
-----END CERTIFICATE-----`;

const certService = new CertService({} as never, {} as never);
const certificateInfo = (pem: string) => ({ crt: [pem] }) as CertificateInfo;

describe("CertService.getCertDnsName", () => {
    it("returns the first DNS Subject Alternative Name", () => {
        expect(
            certService.getCertDnsName(certificateInfo(CERT_WITH_DNS_SAN)),
        ).toBe("verifier.example.com");
    });

    it("rejects a certificate without a DNS Subject Alternative Name", () => {
        const certWithoutSan = readFileSync(
            new URL("../../../../test/cert.pem", import.meta.url),
            "utf8",
        );

        expect(() =>
            certService.getCertDnsName(certificateInfo(certWithoutSan)),
        ).toThrow(BadRequestException);
    });
});

describe("CertService.validateCertificate", () => {
    it("passes the rest of the chain and the root CA to the CRL check", async () => {
        const checkCertificateRevocation = vi
            .fn()
            .mockResolvedValue({ isValid: true });
        const service = new CertService(
            {} as never,
            {} as never,
            {
                checkCertificateRevocation,
            } as never,
        );

        await service.validateCertificate({
            crt: [CERT_WITH_DNS_SAN, "intermediate"],
            keyChain: { rootCertificate: "root" },
        } as CertificateInfo);

        expect(checkCertificateRevocation).toHaveBeenCalledWith(
            CERT_WITH_DNS_SAN,
            ["intermediate", "root"],
        );
    });
});
