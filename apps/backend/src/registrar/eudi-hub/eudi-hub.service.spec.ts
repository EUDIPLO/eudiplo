import { webcrypto, X509Certificate } from "node:crypto";
import { BadGatewayException, BadRequestException } from "@nestjs/common";
import * as x509 from "@peculiar/x509";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyUsageType } from "../../crypto/key/types/key-usage-type.js";
import { EudiHubRequestError } from "./eudi-hub.client.js";
import { EudiHubService } from "./eudi-hub.service.js";

const crypto = webcrypto as Crypto;
const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

async function keyPair(): Promise<CryptoKeyPair> {
    return (await crypto.subtle.generateKey(algorithm, true, [
        "sign",
        "verify",
    ])) as CryptoKeyPair;
}

async function certificate(keys: CryptoKeyPair, name: string) {
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

const ORG = "01932c5a-9abc-7000-8000-000000000010";
const request = {
    token: "eyJ.token.sig",
    organizationId: ORG,
    keyId: "access",
    environment: "sandbox" as const,
    supportUri: "https://support.example",
};

function hubCertificate(id: string, name = "My access key") {
    return {
        id,
        name,
        status: "valid" as const,
        environment: "sandbox" as const,
        createdAt: "2026-11-16T00:00:00Z",
        expirationDate: "2027-11-16T00:00:00Z",
        clientId: "X509_hash:abc",
    };
}

describe("EudiHubService.requestAccessCertificate", () => {
    let keys: CryptoKeyPair;
    let selfSigned: string;
    let issued: string;
    let otherKey: string;
    let client: Record<string, ReturnType<typeof vi.fn>>;
    let keyChainService: Record<string, ReturnType<typeof vi.fn>>;
    let certService: { addCertificate: ReturnType<typeof vi.fn> };
    let service: EudiHubService;

    beforeAll(async () => {
        keys = await keyPair();
        selfSigned = await certificate(keys, "CN=self");
        issued = await certificate(keys, "CN=hub-issued");
        otherKey = await certificate(await keyPair(), "CN=other");
    });

    beforeEach(async () => {
        client = {
            listOrganizations: vi.fn(),
            createAccessCertificate: vi
                .fn()
                .mockResolvedValue(hubCertificate("hub-1")),
            listAccessCertificates: vi.fn().mockResolvedValue([]),
            downloadAccessCertificate: vi.fn().mockResolvedValue(issued),
            revokeAccessCertificate: vi.fn().mockResolvedValue(undefined),
        };
        const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
        keyChainService = {
            getEntity: vi.fn().mockResolvedValue({
                usageType: KeyUsageType.Access,
                description: "My access key",
                activeCertificate: selfSigned,
                hasInternalCa: () => false,
            }),
            createCertificateSigningRequest: vi
                .fn()
                .mockResolvedValue("-----BEGIN CERTIFICATE REQUEST-----"),
            getPublicKey: vi.fn().mockResolvedValue(jwk),
        };
        certService = {
            addCertificate: vi.fn().mockResolvedValue("access"),
        };
        service = new EudiHubService(
            client as any,
            keyChainService as any,
            certService as any,
        );
    });

    it("sends the CSR, downloads the certificate and stores it", async () => {
        const result = await service.requestAccessCertificate("t1", request);

        expect(client.createAccessCertificate).toHaveBeenCalledWith(
            request.token,
            ORG,
            {
                name: "My access key",
                csr: "-----BEGIN CERTIFICATE REQUEST-----",
                environment: "sandbox",
                supportUri: "https://support.example",
            },
        );
        expect(certService.addCertificate).toHaveBeenCalledWith("t1", {
            crt: [issued],
            keyId: "access",
            defaultDescription:
                "Access certificate from the EUDI Hub (sandbox, ID: hub-1)",
        });
        expect(result).toEqual({
            id: "hub-1",
            certId: "access",
            crt: issued,
            environment: "sandbox",
            clientId: "X509_hash:abc",
            expirationDate: "2027-11-16T00:00:00Z",
        });
    });

    it("refuses a key chain that is not a standalone access key chain", async () => {
        keyChainService.getEntity.mockResolvedValue({
            usageType: KeyUsageType.Attestation,
            hasInternalCa: () => false,
        });

        await expect(
            service.requestAccessCertificate("t1", request),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(client.createAccessCertificate).not.toHaveBeenCalled();
    });

    it("answers a refused token with 400, not 401", async () => {
        client.createAccessCertificate.mockRejectedValue(
            new EudiHubRequestError("refused", { status: 401 }),
        );

        const error = await service
            .requestAccessCertificate("t1", request)
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as Error).message).toContain("copy a fresh one");
        expect(client.listAccessCertificates).not.toHaveBeenCalled();
    });

    it("passes on the problem detail of a refused request", async () => {
        client.createAccessCertificate.mockRejectedValue(
            new EudiHubRequestError("refused", {
                status: 422,
                detail: "CSR key too weak",
            }),
        );

        await expect(
            service.requestAccessCertificate("t1", request),
        ).rejects.toThrow(/HTTP 422 \(CSR key too weak\)/);
    });

    it("stores a certificate the EUDI Hub issued although the answer was lost", async () => {
        client.createAccessCertificate.mockRejectedValue(
            new EudiHubRequestError("no answer"),
        );
        client.listAccessCertificates.mockResolvedValue([
            hubCertificate("other-name", "Something else"),
            hubCertificate("other-key"),
            hubCertificate("hub-2"),
        ]);
        client.downloadAccessCertificate.mockImplementation(
            (_t: string, _o: string, id: string) =>
                Promise.resolve(id === "other-key" ? otherKey : issued),
        );

        const result = await service.requestAccessCertificate("t1", request);

        expect(result.id).toBe("hub-2");
        expect(client.downloadAccessCertificate).not.toHaveBeenCalledWith(
            request.token,
            ORG,
            "other-name",
        );
        expect(client.revokeAccessCertificate).not.toHaveBeenCalled();
    });

    it("does not take the certificate the key chain already holds as recovered", async () => {
        client.createAccessCertificate.mockRejectedValue(
            new EudiHubRequestError("server error", { status: 503 }),
        );
        client.listAccessCertificates.mockResolvedValue([
            hubCertificate("hub-old"),
            hubCertificate("hub-2"),
        ]);
        client.downloadAccessCertificate.mockImplementation(
            (_t: string, _o: string, id: string) =>
                Promise.resolve(id === "hub-old" ? selfSigned : issued),
        );

        const result = await service.requestAccessCertificate("t1", request);

        expect(result.id).toBe("hub-2");
    });

    it("revokes a certificate that cannot be stored", async () => {
        certService.addCertificate.mockRejectedValue(
            new BadRequestException("not for this key"),
        );

        await expect(
            service.requestAccessCertificate("t1", request),
        ).rejects.toThrow("not for this key");
        expect(client.revokeAccessCertificate).toHaveBeenCalledWith(
            request.token,
            ORG,
            "hub-1",
        );
    });

    it("revokes a certificate that cannot be downloaded", async () => {
        client.downloadAccessCertificate.mockRejectedValue(
            new EudiHubRequestError("no answer"),
        );

        await expect(
            service.requestAccessCertificate("t1", request),
        ).rejects.toBeInstanceOf(BadGatewayException);
        expect(client.revokeAccessCertificate).toHaveBeenCalledWith(
            request.token,
            ORG,
            "hub-1",
        );
        expect(certService.addCertificate).not.toHaveBeenCalled();
    });

    it("refuses an access key chain with an internal CA", async () => {
        keyChainService.getEntity.mockResolvedValue({
            usageType: KeyUsageType.Access,
            hasInternalCa: () => true,
        });

        await expect(
            service.requestAccessCertificate("t1", request),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(client.createAccessCertificate).not.toHaveBeenCalled();
    });

    it("names the certificate as requested, else after a non-blank description, else after the key chain", async () => {
        await service.requestAccessCertificate("t1", {
            ...request,
            name: "Custom",
        });
        expect(client.createAccessCertificate.mock.lastCall?.[2].name).toBe(
            "Custom",
        );

        keyChainService.getEntity.mockResolvedValue({
            usageType: KeyUsageType.Access,
            description: "  ",
            activeCertificate: selfSigned,
            hasInternalCa: () => false,
        });
        await service.requestAccessCertificate("t1", request);
        expect(client.createAccessCertificate.mock.lastCall?.[2].name).toBe(
            "access",
        );
    });

    it.each([
        ["a refusal", new EudiHubRequestError("refused", { status: 400 })],
        [
            "a request the outbound URL policy blocked",
            new EudiHubRequestError("blocked", { blocked: true }),
        ],
    ])("does not look for an issued certificate after %s", async (_, error) => {
        client.createAccessCertificate.mockRejectedValue(error);

        await expect(
            service.requestAccessCertificate("t1", request),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(client.listAccessCertificates).not.toHaveBeenCalled();
    });

    it("passes on the reason of the outbound URL policy", async () => {
        client.createAccessCertificate.mockRejectedValue(
            new EudiHubRequestError("Host api.example is not allowed", {
                blocked: true,
            }),
        );

        await expect(
            service.requestAccessCertificate("t1", request),
        ).rejects.toThrow(/Host api\.example is not allowed/);
    });

    it("reports a permission refusal of the EUDI Hub with its detail", async () => {
        client.createAccessCertificate.mockRejectedValue(
            new EudiHubRequestError("refused", {
                status: 403,
                detail: "Missing scope",
            }),
        );

        const error = await service
            .requestAccessCertificate("t1", request)
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as Error).message).toMatch(
            /HTTP 403\) \(Missing scope\).*may lack the permission/,
        );
    });

    it("passes on the detail of a server error as 502", async () => {
        client.createAccessCertificate.mockRejectedValue(
            new EudiHubRequestError("failed", {
                status: 500,
                detail: "Upstream CA down",
            }),
        );

        const error = await service
            .requestAccessCertificate("t1", request)
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BadGatewayException);
        expect((error as Error).message).toContain(
            "HTTP 500 (Upstream CA down)",
        );
    });

    it("says what was wrong with an answer that does not match the EUDI Hub API", async () => {
        client.downloadAccessCertificate.mockRejectedValue(
            new EudiHubRequestError("answered without a certificate", {
                invalidAnswer: true,
            }),
        );

        const error = await service
            .requestAccessCertificate("t1", request)
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BadGatewayException);
        expect((error as Error).message).toContain(
            "answered without a certificate",
        );
        expect((error as Error).message).not.toContain("could not be reached");
    });

    it("answers an unexpected error with 502 and points to the log", async () => {
        client.createAccessCertificate.mockRejectedValue(new TypeError("bug"));

        await expect(
            service.requestAccessCertificate("t1", request),
        ).rejects.toThrow(/the server log has the cause/);
    });

    it("downloads at most five certificates of the same name when looking for an issued one", async () => {
        client.createAccessCertificate.mockRejectedValue(
            new EudiHubRequestError("no answer"),
        );
        client.listAccessCertificates.mockResolvedValue(
            Array.from({ length: 7 }, (_, i) => hubCertificate(`c${i}`)),
        );
        client.downloadAccessCertificate.mockResolvedValue(otherKey);

        await expect(
            service.requestAccessCertificate("t1", request),
        ).rejects.toBeInstanceOf(BadGatewayException);
        expect(client.downloadAccessCertificate).toHaveBeenCalledTimes(5);
    });

    it("keeps the original error when the lookup of an issued certificate fails", async () => {
        client.createAccessCertificate.mockRejectedValue(
            new EudiHubRequestError("no answer"),
        );
        client.listAccessCertificates.mockRejectedValue(
            new EudiHubRequestError("refused", { status: 403 }),
        );

        const error = await service
            .requestAccessCertificate("t1", request)
            .catch((e: unknown) => e);
        expect((error as Error).message).toMatch(/could not be reached/);
        expect((error as Error).message).not.toContain("403");
        expect(client.downloadAccessCertificate).not.toHaveBeenCalled();
    });

    it("skips a candidate that cannot be downloaded and stores a matching one after it", async () => {
        client.createAccessCertificate.mockRejectedValue(
            new EudiHubRequestError("no answer"),
        );
        client.listAccessCertificates.mockResolvedValue([
            hubCertificate("hub-a"),
            hubCertificate("hub-2"),
        ]);
        client.downloadAccessCertificate.mockImplementation(
            (_t: string, _o: string, id: string) =>
                id === "hub-a"
                    ? Promise.reject(
                          new EudiHubRequestError("gone", { status: 404 }),
                      )
                    : Promise.resolve(issued),
        );

        const result = await service.requestAccessCertificate("t1", request);

        expect(result.id).toBe("hub-2");
    });

    it("does not take a revoked certificate as issued", async () => {
        client.createAccessCertificate.mockRejectedValue(
            new EudiHubRequestError("no answer"),
        );
        client.listAccessCertificates.mockResolvedValue([
            { ...hubCertificate("hub-revoked"), status: "revoked" },
        ]);

        await expect(
            service.requestAccessCertificate("t1", request),
        ).rejects.toBeInstanceOf(BadGatewayException);
        expect(client.downloadAccessCertificate).not.toHaveBeenCalled();
    });

    it("looks for an issued certificate after an answer that does not match the EUDI Hub API", async () => {
        client.createAccessCertificate.mockRejectedValue(
            new EudiHubRequestError("no id", { invalidAnswer: true }),
        );
        client.listAccessCertificates.mockResolvedValue([
            hubCertificate("hub-2"),
        ]);

        const result = await service.requestAccessCertificate("t1", request);

        expect(result.id).toBe("hub-2");
    });

    it("does not revoke a found certificate it cannot store, as it may be older than this request", async () => {
        client.createAccessCertificate.mockRejectedValue(
            new EudiHubRequestError("no answer"),
        );
        client.listAccessCertificates.mockResolvedValue([
            hubCertificate("hub-2"),
        ]);
        certService.addCertificate.mockRejectedValue(
            new BadRequestException("not for this key"),
        );

        await expect(
            service.requestAccessCertificate("t1", request),
        ).rejects.toThrow("not for this key");
        expect(client.revokeAccessCertificate).not.toHaveBeenCalled();
    });

    it("keeps the download error when the revocation fails too", async () => {
        client.downloadAccessCertificate.mockRejectedValue(
            new EudiHubRequestError("no answer"),
        );
        client.revokeAccessCertificate.mockRejectedValue(
            new EudiHubRequestError("refused", { status: 409 }),
        );

        await expect(
            service.requestAccessCertificate("t1", request),
        ).rejects.toBeInstanceOf(BadGatewayException);
    });
});

describe("EudiHubService issuing CA of an access certificate", () => {
    const AIA = "http://ca.example/issuing.cer";

    async function ca(
        name: string,
        signer?: { keys: CryptoKeyPair; name: string },
    ) {
        const keys = await keyPair();
        const cert = await x509.X509CertificateGenerator.create(
            {
                serialNumber: "02",
                subject: name,
                issuer: signer?.name ?? name,
                notBefore: new Date(Date.now() - 60_000),
                notAfter: new Date(Date.now() + 3_600_000),
                signingAlgorithm: algorithm,
                publicKey: keys.publicKey,
                signingKey: (signer?.keys ?? keys).privateKey,
                extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
            },
            crypto,
        );
        return { keys, name, pem: cert.toString("pem") };
    }

    async function leafFrom(
        issuer: { keys: CryptoKeyPair; name: string },
        key: CryptoKeyPair,
        aia = true,
    ) {
        const cert = await x509.X509CertificateGenerator.create(
            {
                serialNumber: "03",
                subject: "CN=Relying party",
                issuer: issuer.name,
                notBefore: new Date(Date.now() - 60_000),
                notAfter: new Date(Date.now() + 3_600_000),
                signingAlgorithm: algorithm,
                publicKey: key.publicKey,
                signingKey: issuer.keys.privateKey,
                extensions: aia
                    ? [
                          new x509.AuthorityInfoAccessExtension({
                              caIssuers: AIA,
                          }),
                      ]
                    : [],
            },
            crypto,
        );
        return cert.toString("pem");
    }

    let key: CryptoKeyPair;
    let client: Record<string, ReturnType<typeof vi.fn>>;
    let certService: { addCertificate: ReturnType<typeof vi.fn> };
    let service: EudiHubService;

    beforeEach(async () => {
        key = await keyPair();
        client = {
            createAccessCertificate: vi
                .fn()
                .mockResolvedValue(hubCertificate("hub-1")),
            downloadAccessCertificate: vi.fn(),
            fetchCaCertificate: vi.fn(),
            revokeAccessCertificate: vi.fn(),
        };
        certService = { addCertificate: vi.fn().mockResolvedValue("access") };
        service = new EudiHubService(
            client as any,
            {
                getEntity: vi.fn().mockResolvedValue({
                    usageType: KeyUsageType.Access,
                    description: "My access key",
                    hasInternalCa: () => false,
                }),
                createCertificateSigningRequest: vi
                    .fn()
                    .mockResolvedValue("csr"),
            } as any,
            certService as any,
        );
    });

    it("stores the issuing CA the certificate names after it", async () => {
        const root = await ca("CN=Hub Root");
        const issuing = await ca("CN=Hub Issuing", root);
        const leaf = await leafFrom(issuing, key);
        client.downloadAccessCertificate.mockResolvedValue(leaf);
        client.fetchCaCertificate.mockResolvedValue(
            new X509Certificate(issuing.pem),
        );

        await service.requestAccessCertificate("t1", request);

        expect(client.fetchCaCertificate).toHaveBeenCalledWith(AIA);
        const chain = certService.addCertificate.mock.lastCall?.[1].crt;
        expect(chain).toHaveLength(2);
        expect(new X509Certificate(chain[1]).subject).toBe("CN=Hub Issuing");
    });

    it("leaves out a self-signed issuer, which is the trust anchor", async () => {
        const root = await ca("CN=Hub Root");
        const leaf = await leafFrom(root, key);
        client.downloadAccessCertificate.mockResolvedValue(leaf);
        client.fetchCaCertificate.mockResolvedValue(
            new X509Certificate(root.pem),
        );

        await service.requestAccessCertificate("t1", request);

        expect(certService.addCertificate.mock.lastCall?.[1].crt).toEqual([
            leaf,
        ]);
    });

    it("stores the certificate alone when the fetched CA did not issue it", async () => {
        const issuing = await ca("CN=Hub Issuing");
        const other = await ca("CN=Hub Issuing");
        const leaf = await leafFrom(issuing, key);
        client.downloadAccessCertificate.mockResolvedValue(leaf);
        client.fetchCaCertificate.mockResolvedValue(
            new X509Certificate(other.pem),
        );

        await service.requestAccessCertificate("t1", request);

        expect(certService.addCertificate.mock.lastCall?.[1].crt).toEqual([
            leaf,
        ]);
    });

    it("stores the certificate alone when the CA cannot be fetched or is not named", async () => {
        const issuing = await ca("CN=Hub Issuing");
        client.downloadAccessCertificate.mockResolvedValue(
            await leafFrom(issuing, key),
        );
        client.fetchCaCertificate.mockRejectedValue(
            new EudiHubRequestError("blocked", { blocked: true }),
        );

        await service.requestAccessCertificate("t1", request);
        expect(certService.addCertificate.mock.lastCall?.[1].crt).toHaveLength(
            1,
        );

        const withoutAia = await leafFrom(issuing, key, false);
        client.downloadAccessCertificate.mockResolvedValue(withoutAia);
        client.fetchCaCertificate.mockClear();
        await service.requestAccessCertificate("t1", request);
        expect(client.fetchCaCertificate).not.toHaveBeenCalled();
        expect(certService.addCertificate.mock.lastCall?.[1].crt).toEqual([
            withoutAia,
        ]);
    });
});

describe("EudiHubService.listOrganizations", () => {
    it("reports a refused token as 400", async () => {
        const client = {
            listOrganizations: vi
                .fn()
                .mockRejectedValue(
                    new EudiHubRequestError("refused", { status: 401 }),
                ),
        };
        const service = new EudiHubService(client as any, {} as any, {} as any);

        const error = await service
            .listOrganizations("t1", "token")
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as Error).message).toContain(
            "Could not read the organizations",
        );
    });
});
