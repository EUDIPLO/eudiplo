import * as x509 from "@peculiar/x509";
import { base64url } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InvalidTrustedAuthoritiesError } from "./ports/trust-list-ref-resolver.js";
import { TrustedAuthoritiesService } from "./trusted-authorities.service.js";

function createService(getVerifierX509Der = vi.fn()) {
    const logger = { setContext: vi.fn(), warn: vi.fn() };
    const service = new TrustedAuthoritiesService(
        { getVerifierX509Der } as any,
        logger as any,
    );
    return { service, logger, getVerifierX509Der };
}

describe("TrustedAuthoritiesService", () => {
    let certDer: string;
    let expectedAki: string;

    beforeAll(async () => {
        x509.cryptoProvider.set(globalThis.crypto);
        const keys = await globalThis.crypto.subtle.generateKey(
            { name: "ECDSA", namedCurve: "P-256" },
            true,
            ["sign", "verify"],
        );
        const cert = await x509.X509CertificateGenerator.createSelfSigned({
            name: "CN=Trust Anchor",
            keys,
            signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
            extensions: [
                await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
            ],
        });
        certDer = Buffer.from(cert.rawData).toString("base64");
        const ski = cert.getExtension(x509.SubjectKeyIdentifierExtension);
        expectedAki = base64url.encode(Buffer.from(ski!.keyId, "hex"));
    });

    describe("transformDcqlTrustedAuthoritiesToAki", () => {
        it("replaces etsi_tl entries with the trust anchors' SKIs", async () => {
            const { service, getVerifierX509Der } = createService(
                vi.fn().mockResolvedValue(certDer),
            );
            const other = { type: "openid_federation", values: ["x"] };

            const result = await service.transformDcqlTrustedAuthoritiesToAki(
                {
                    credentials: [
                        {
                            id: "pid",
                            trusted_authorities: [
                                {
                                    type: "etsi_tl",
                                    values: [
                                        { trustListId: "managed", url: "u" },
                                        { verifierX509Der: certDer, url: "u" },
                                    ],
                                },
                                other,
                            ],
                        },
                        { id: "plain" },
                    ],
                },
                "tenant",
            );

            expect(getVerifierX509Der).toHaveBeenCalledWith(
                "tenant",
                "managed",
            );
            expect(result.credentials).toEqual([
                {
                    id: "pid",
                    trusted_authorities: [
                        { type: "aki", values: [expectedAki, expectedAki] },
                        other,
                    ],
                },
                { id: "plain" },
            ]);
        });

        it("leaves an etsi_tl entry unchanged when no SKI can be resolved", async () => {
            const { service, logger } = createService(
                vi.fn().mockRejectedValue(new Error("unknown trust list")),
            );
            const entry = {
                type: "etsi_tl",
                values: [{ trustListId: "missing" }, { verifierX509Der: "AA" }],
            };

            const result = await service.transformDcqlTrustedAuthoritiesToAki(
                { credentials: [{ id: "pid", trusted_authorities: [entry] }] },
                "tenant",
            );

            expect(result.credentials[0].trusted_authorities).toEqual([entry]);
            expect(logger.warn).toHaveBeenCalledTimes(2);
        });

        it("returns queries without credentials unchanged", async () => {
            const { service } = createService();
            const query = { credential_sets: [] };
            await expect(
                service.transformDcqlTrustedAuthoritiesToAki(query, "tenant"),
            ).resolves.toBe(query);
        });
    });

    describe("resolveTrustListRefsForTenant", () => {
        const host = "https://eudiplo.example/issuers/tenant";

        it("resolves managed and external trust lists", async () => {
            const { service } = createService(vi.fn().mockResolvedValue("DER"));

            await expect(
                service.resolveTrustListRefsForTenant(
                    [
                        { trustListId: " list 1 ", url: "ignored" },
                        {
                            url: "<TENANT_URL>/trust-list/external",
                            verifierX509Der: "X",
                        },
                    ],
                    "tenant",
                    host,
                ),
            ).resolves.toEqual([
                {
                    trustListId: "list 1",
                    url: `${host}/trust-list/list%201`,
                    verifierX509Der: "DER",
                },
                {
                    trustListId: undefined,
                    url: `${host}/trust-list/external`,
                    verifierX509Der: "X",
                },
            ]);
        });

        it("returns no references for an empty list", async () => {
            const { service } = createService();
            await expect(
                service.resolveTrustListRefsForTenant(undefined, "t", host),
            ).resolves.toEqual([]);
        });

        it("rejects blank trust-list ids and missing urls", async () => {
            const { service } = createService();
            await expect(
                service.resolveTrustListRefsForTenant(
                    [{ trustListId: "  ", url: "u" }],
                    "t",
                    host,
                ),
            ).rejects.toThrow(
                new InvalidTrustedAuthoritiesError(
                    "trusted_authorities values trustListId must not be empty",
                ),
            );
            await expect(
                service.resolveTrustListRefsForTenant([{ url: "" }], "t", host),
            ).rejects.toBeInstanceOf(InvalidTrustedAuthoritiesError);
        });
    });
});
