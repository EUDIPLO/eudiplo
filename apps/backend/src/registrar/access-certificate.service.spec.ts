import { webcrypto } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import * as x509 from "@peculiar/x509";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyUsageType } from "../crypto/key/types/key-usage-type.js";
import { AccessCertificateService } from "./access-certificate.service.js";
import { accessCertificateControllerAccessCertificates } from "./generated/index.js";

vi.mock("./generated/index.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./generated/index.js")>()),
    accessCertificateControllerAccessCertificates: vi.fn(),
}));

const crypto = webcrypto as Crypto;
const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

async function selfSigned(name: string): Promise<string> {
    const keys = (await crypto.subtle.generateKey(algorithm, true, [
        "sign",
        "verify",
    ])) as CryptoKeyPair;
    const cert = await x509.X509CertificateGenerator.createSelfSigned(
        {
            serialNumber: "01",
            name,
            notBefore: new Date(Date.now() - 60_000),
            notAfter: new Date(Date.now() + 3_600_000),
            keys,
            signingAlgorithm: algorithm,
        },
        crypto,
    );
    return cert.toString("pem");
}

function registrarEntry(
    id: string,
    certificate: string,
    revoked: string | null = null,
) {
    return {
        id,
        relyingPartyId: "rp-1",
        certificate,
        issuanceMethod: "csr" as const,
        profile: "generic-wrpac" as const,
        revoked,
        createdAt: "2026-10-01T00:00:00Z",
    };
}

describe("AccessCertificateService.findRegistrarAccessCertificateId", () => {
    const client = {} as any;
    let signing: string;
    let other: string;
    let certService: { find: ReturnType<typeof vi.fn> };
    let service: AccessCertificateService;

    beforeAll(async () => {
        signing = await selfSigned("CN=access.example");
        other = await selfSigned("CN=other.example");
    });

    beforeEach(() => {
        certService = {
            find: vi
                .fn()
                .mockResolvedValue({ keyId: "access", crt: [signing] }),
        };
        service = new AccessCertificateService(
            {} as any,
            {} as any,
            certService as any,
            {} as any,
        );
    });

    function registrarReturns(...entries: ReturnType<typeof registrarEntry>[]) {
        vi.mocked(
            accessCertificateControllerAccessCertificates,
        ).mockResolvedValue({ data: entries } as any);
    }

    it("returns the registrar id of the certificate held by the access key chain", async () => {
        registrarReturns(
            registrarEntry("ac-other", other),
            registrarEntry("ac-signing", signing),
        );

        await expect(
            service.findRegistrarAccessCertificateId(
                "tenant",
                client,
                "rp-1",
                "access",
            ),
        ).resolves.toBe("ac-signing");
        expect(certService.find).toHaveBeenCalledWith({
            tenantId: "tenant",
            type: KeyUsageType.Access,
            keyId: "access",
            skipValidation: true,
        });
        expect(
            accessCertificateControllerAccessCertificates,
        ).toHaveBeenCalledWith({ client, query: { rp: "rp-1" } });
    });

    it("ignores a revoked access certificate", async () => {
        registrarReturns(
            registrarEntry("ac-signing", signing, "2026-10-02T00:00:00Z"),
        );

        await expect(
            service.findRegistrarAccessCertificateId("tenant", client, "rp-1"),
        ).rejects.toThrow(BadRequestException);
    });

    it("rejects a certificate the registrar did not issue", async () => {
        registrarReturns(registrarEntry("ac-other", other));

        await expect(
            service.findRegistrarAccessCertificateId("tenant", client, "rp-1"),
        ).rejects.toThrow(
            "The certificate of access key chain 'access' is not an active access certificate at the registrar",
        );
    });
});
