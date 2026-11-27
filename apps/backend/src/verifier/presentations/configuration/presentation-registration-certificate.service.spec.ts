import { webcrypto } from "node:crypto";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import * as x509 from "@peculiar/x509";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeyUsageType } from "../../../crypto/key/types/key-usage-type.js";
import { PresentationRegistrationCertificateService } from "./presentation-registration-certificate.service.js";

const now = () => Math.floor(Date.now() / 1000);
const unsigned = (payload: Record<string, unknown>) =>
    `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.`;

const query = (vct: string) => ({
    credentials: [
        {
            id: "pid",
            format: "dc+sd-jwt",
            meta: { vct_values: [vct] },
            claims: [{ path: ["age_over_18"] }],
        },
    ],
});
const certificate = (vct: string, exp = now() + 3600, sub?: object) =>
    unsigned({
        exp,
        sub,
        credentials: [
            {
                format: "dc+sd-jwt",
                meta: { vct_values: [vct] },
                claims: [{ path: ["age_over_18"] }],
            },
        ],
    });

const RP_ID = "LEIXG-529900T8BM49AURSDO55";
let accessPem: string;
beforeAll(async () => {
    const crypto = webcrypto as Crypto;
    const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
    const keys = (await crypto.subtle.generateKey(algorithm, true, [
        "sign",
        "verify",
    ])) as CryptoKeyPair;
    accessPem = (
        await x509.X509CertificateGenerator.createSelfSigned(
            {
                serialNumber: "01",
                name: `CN=Example, 2.5.4.97=${RP_ID}`,
                notBefore: new Date(Date.now() - 60_000),
                notAfter: new Date(Date.now() + 3_600_000),
                signingAlgorithm: algorithm,
                keys,
            },
            crypto,
        )
    ).toString("pem");
});

function setup(
    skipOveraskingCheck = false,
    find: (options: unknown) => Promise<{ crt: string[] }> = () =>
        Promise.resolve({ crt: [accessPem] }),
) {
    const logger = {
        setContext: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    };
    const certService = { find: vi.fn(find) };
    const service = new PresentationRegistrationCertificateService(
        {
            publicUrl: "https://eudiplo.example",
            skipOveraskingCheck,
        },
        certService as never,
        logger as never,
    );
    return { service, logger, certService };
}

const config = (jwt?: string) => ({
    id: "age",
    tenantId: "t",
    registration_cert: jwt ? { jwt } : null,
});

describe("PresentationRegistrationCertificateService.forRequest", () => {
    it("attaches nothing without a JWT", () => {
        const { service } = setup();
        expect(
            service.forRequest(config(), query("urn:pid"), accessPem, "r"),
        ).toBeUndefined();
    });

    it("attaches a valid certificate that authorizes the query", () => {
        const { service } = setup();
        const jwt = certificate("urn:pid");
        expect(
            service.forRequest(config(jwt), query("urn:pid"), accessPem, "r"),
        ).toBe(jwt);
    });

    it("refuses a certificate that has expired since it was stored, and logs a warning", () => {
        const { service, logger } = setup();
        expect(() =>
            service.forRequest(
                config(certificate("urn:pid", now() - 3600)),
                query("urn:pid"),
                accessPem,
                "r",
            ),
        ).toThrow(BadRequestException);
        expect(logger.warn).toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
    });

    it("refuses an overasking certificate and logs an error", () => {
        const { service, logger } = setup();
        expect(() =>
            service.forRequest(
                config(certificate("urn:other")),
                query("urn:pid"),
                accessPem,
                "r",
            ),
        ).toThrow(BadRequestException);
        expect(logger.error).toHaveBeenCalled();
    });

    it("refuses a certificate issued to another relying party than the access certificate's and logs an error", () => {
        const { service, logger } = setup();
        expect(() =>
            service.forRequest(
                config(certificate("urn:pid", undefined, { id: "VATDE-1" })),
                query("urn:pid"),
                accessPem,
                "r",
            ),
        ).toThrow(/does not belong to the access certificate/);
        expect(logger.error).toHaveBeenCalled();
        const jwt = certificate("urn:pid", undefined, { id: RP_ID });
        expect(
            service.forRequest(config(jwt), query("urn:pid"), accessPem, "r"),
        ).toBe(jwt);
    });

    it("attaches an overasking certificate with SKIP_OVERASKING_CHECK and warns", () => {
        const { service, logger } = setup(true);
        const jwt = certificate("urn:other");
        expect(
            service.forRequest(config(jwt), query("urn:pid"), accessPem, "r"),
        ).toBe(jwt);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.anything(),
            expect.stringMatching(/SKIP_OVERASKING_CHECK/),
        );
    });
});

describe("PresentationRegistrationCertificateService.validate", () => {
    it("checks against the DCQL query with <TENANT_URL> resolved", async () => {
        const { service } = setup();
        const vct = "https://eudiplo.example/issuers/t/vct/pid";

        await expect(
            service.validate({
                ...config(certificate(vct)),
                dcql_query: query("<TENANT_URL>/vct/pid"),
            }),
        ).resolves.toBeUndefined();
        await expect(
            service.validate({
                ...config(certificate("urn:other")),
                dcql_query: query("<TENANT_URL>/vct/pid"),
            }),
        ).rejects.toThrow(BadRequestException);
    });

    it("accepts a configuration without a JWT", async () => {
        const { service, certService } = setup();
        await expect(
            service.validate({ ...config(), dcql_query: query("urn:pid") }),
        ).resolves.toBeUndefined();
        expect(certService.find).not.toHaveBeenCalled();
    });

    it("matches the certificate against the pinned access key chain", async () => {
        const { service, certService } = setup();
        await expect(
            service.validate({
                ...config(certificate("urn:pid", undefined, { id: RP_ID })),
                dcql_query: query("urn:pid"),
                accessKeyChainId: "access-2",
            }),
        ).resolves.toBeUndefined();
        expect(certService.find).toHaveBeenCalledWith({
            tenantId: "t",
            type: KeyUsageType.Access,
            keyId: "access-2",
            skipValidation: true,
        });
        await expect(
            service.validate({
                ...config(certificate("urn:pid", undefined, { id: "VATDE-1" })),
                dcql_query: query("urn:pid"),
            }),
        ).rejects.toThrow(/does not belong to the access certificate/);
    });

    it("looks up the default access key chain without accessKeyChainId", async () => {
        const { service, certService } = setup();
        await service.validate({
            ...config(certificate("urn:pid", undefined, { id: RP_ID })),
            dcql_query: query("urn:pid"),
            accessKeyChainId: null,
        });
        expect(certService.find).toHaveBeenCalledWith(
            expect.objectContaining({ keyId: undefined }),
        );
    });

    it("fails the save when the key chain lookup fails for another reason", async () => {
        const { service } = setup(false, () =>
            Promise.reject(new Error("database down")),
        );
        await expect(
            service.validate({
                ...config(certificate("urn:pid")),
                dcql_query: query("urn:pid"),
            }),
        ).rejects.toThrow("database down");
    });

    it("leaves the access certificate match to the request without an access key chain", async () => {
        const { service } = setup(false, () =>
            Promise.reject(new NotFoundException("none")),
        );
        await expect(
            service.validate({
                ...config(certificate("urn:pid", undefined, { id: "VATDE-1" })),
                dcql_query: query("urn:pid"),
            }),
        ).resolves.toBeUndefined();
    });
});
