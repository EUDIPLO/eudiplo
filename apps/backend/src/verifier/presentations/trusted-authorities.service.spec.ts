import * as x509 from "@peculiar/x509";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
    ServiceTypeIdentifiers,
    type TrustedEntity,
} from "../../trust/types.js";
import { InvalidTrustedAuthoritiesError } from "./ports/trust-list-ref-resolver.js";
import { TrustedAuthoritiesService } from "./trusted-authorities.service.js";

function createService(
    getVerifierX509Der = vi.fn(),
    getListedEntities = vi.fn(),
) {
    const logger = { setContext: vi.fn(), warn: vi.fn() };
    const service = new TrustedAuthoritiesService(
        { getVerifierX509Der } as any,
        { getListedEntities } as any,
        logger as any,
    );
    return { service, logger, getVerifierX509Der, getListedEntities };
}

/** A self-signed certificate; `ca: false` is a pinned signer without AKI. */
async function createCa(name: string, ca = true) {
    const keys = await globalThis.crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
    );
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        name,
        keys,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        extensions: [
            new x509.BasicConstraintsExtension(ca),
            await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
        ],
    });
    return {
        der: Buffer.from(cert.rawData).toString("base64"),
        ski: Buffer.from(
            cert.getExtension(x509.SubjectKeyIdentifierExtension)!.keyId,
            "hex",
        ).toString("base64url"),
    };
}

const issuer = (serviceTypeIdentifier: string, certValue: string) =>
    [
        {
            entityId: "Issuer",
            services: [
                { serviceTypeIdentifier, certValue },
                {
                    serviceTypeIdentifier: ServiceTypeIdentifiers.EaaRevocation,
                    certValue,
                },
            ],
        },
    ] satisfies TrustedEntity[];

describe("TrustedAuthoritiesService", () => {
    const host = "https://eudiplo.example/issuers/tenant";
    let eaaCa: { der: string; ski: string };
    let pidCa: { der: string; ski: string };
    let trustListSigner: { der: string; ski: string };
    let standaloneSigner: { der: string; ski: string };

    beforeAll(async () => {
        x509.cryptoProvider.set(globalThis.crypto);
        eaaCa = await createCa("CN=EAA Issuer CA");
        pidCa = await createCa("CN=PID Issuer CA");
        trustListSigner = await createCa("CN=Trust List Signer");
        standaloneSigner = await createCa("CN=Standalone Signer", false);
    });

    describe("transformDcqlTrustedAuthoritiesToAki", () => {
        it("also sends the URL of lists with issuers no key identifier matches", async () => {
            const { service } = createService(
                vi.fn(),
                vi.fn(async (ref) =>
                    ref.trustListId === "standalone"
                        ? issuer(
                              ServiceTypeIdentifiers.EaaIssuance,
                              standaloneSigner.der,
                          )
                        : issuer(ServiceTypeIdentifiers.EaaIssuance, eaaCa.der),
                ),
            );

            const result = await service.transformDcqlTrustedAuthoritiesToAki(
                {
                    credentials: [
                        {
                            id: "pid",
                            trusted_authorities: [
                                {
                                    type: "etsi_tl",
                                    values: [
                                        { trustListId: "standalone" },
                                        { trustListId: "ca" },
                                    ],
                                },
                            ],
                        },
                    ],
                },
                "tenant",
                host,
            );

            expect(result.credentials[0].trusted_authorities).toEqual([
                {
                    type: "aki",
                    values: [standaloneSigner.ski, eaaCa.ski],
                },
                {
                    type: "etsi_tl",
                    values: [`${host}/trust-list/standalone`],
                },
            ]);
        });

        it("replaces etsi_tl entries with the key identifiers of the listed issuers", async () => {
            const { service, getVerifierX509Der, getListedEntities } =
                createService(
                    vi.fn().mockResolvedValue(trustListSigner.der),
                    vi.fn(async (ref) =>
                        ref.trustListId
                            ? issuer(
                                  ServiceTypeIdentifiers.EaaIssuance,
                                  eaaCa.der,
                              )
                            : issuer(
                                  ServiceTypeIdentifiers.PIDIssuance,
                                  pidCa.der,
                              ),
                    ),
                );
            const other = { type: "openid_federation", values: ["x"] };
            const external = {
                url: "https://lists.example/pid",
                verifierX509Der: trustListSigner.der,
            };

            const result = await service.transformDcqlTrustedAuthoritiesToAki(
                {
                    credentials: [
                        {
                            id: "pid",
                            trusted_authorities: [
                                {
                                    type: "etsi_tl",
                                    values: [
                                        { trustListId: "managed", url: "" },
                                        external,
                                        { trustListId: "managed-again" },
                                    ],
                                },
                                other,
                            ],
                        },
                        { id: "plain" },
                    ],
                },
                "tenant",
                host,
            );

            expect(getListedEntities).toHaveBeenCalledWith(
                { trustListId: "managed", url: "" },
                "tenant",
            );
            expect(getListedEntities).toHaveBeenCalledWith(external, "tenant");
            // The certificate that signs the trust list is not an issuer.
            expect(getVerifierX509Der).not.toHaveBeenCalled();
            expect(result.credentials).toEqual([
                {
                    id: "pid",
                    trusted_authorities: [
                        { type: "aki", values: [eaaCa.ski, pidCa.ski] },
                        other,
                    ],
                },
                { id: "plain" },
            ]);
        });

        it("sends plain trust-list URLs for lists without key identifiers", async () => {
            const { service, logger } = createService(
                vi.fn(),
                vi.fn(async (ref) => {
                    if (ref.trustListId === "missing") {
                        throw new Error("unknown trust list");
                    }
                    return ref.trustListId
                        ? issuer(ServiceTypeIdentifiers.EaaIssuance, eaaCa.der)
                        : issuer(
                              ServiceTypeIdentifiers.WalletSolutionIssuance,
                              pidCa.der,
                          );
                }),
            );

            const result = await service.transformDcqlTrustedAuthoritiesToAki(
                {
                    credentials: [
                        {
                            id: "pid",
                            trusted_authorities: [
                                {
                                    type: "etsi_tl",
                                    values: [
                                        { trustListId: "missing" },
                                        { trustListId: "listed" },
                                        {
                                            url: "https://lists.example/wallets",
                                            verifierX509Der: "AA",
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
                "tenant",
                host,
            );

            expect(result.credentials[0].trusted_authorities).toEqual([
                { type: "aki", values: [eaaCa.ski] },
                {
                    type: "etsi_tl",
                    values: [
                        `${host}/trust-list/missing`,
                        "https://lists.example/wallets",
                    ],
                },
            ]);
            expect(logger.warn).toHaveBeenCalledTimes(2);
        });

        it("only sends string values to the wallet", async () => {
            const { service } = createService(
                vi.fn(),
                vi.fn().mockRejectedValue(new Error("unreachable")),
            );

            const result = await service.transformDcqlTrustedAuthoritiesToAki(
                {
                    credentials: [
                        {
                            id: "pid",
                            trusted_authorities: [
                                {
                                    type: "etsi_tl",
                                    values: [{ trustListId: "a b" }],
                                },
                            ],
                        },
                    ],
                },
                "tenant",
                host,
            );

            expect(result.credentials[0].trusted_authorities).toEqual([
                { type: "etsi_tl", values: [`${host}/trust-list/a%20b`] },
            ]);
        });

        it("drops trusted_authorities that end up empty", async () => {
            const { service, getListedEntities } = createService();

            const result = await service.transformDcqlTrustedAuthoritiesToAki(
                {
                    credentials: [
                        {
                            id: "pid",
                            trusted_authorities: [
                                { type: "etsi_tl", values: [] },
                            ],
                        },
                    ],
                },
                "tenant",
                host,
            );

            expect(result.credentials).toEqual([{ id: "pid" }]);
            expect(getListedEntities).not.toHaveBeenCalled();
        });

        it("returns queries without credentials unchanged", async () => {
            const { service } = createService();
            const query = { credential_sets: [] };
            await expect(
                service.transformDcqlTrustedAuthoritiesToAki(
                    query,
                    "tenant",
                    host,
                ),
            ).resolves.toBe(query);
        });
    });

    describe("resolveTrustListRefsForTenant", () => {
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
