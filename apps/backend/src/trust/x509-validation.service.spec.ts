import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import {
    certificateFailure,
    currentPeriod,
    outsideStates,
    periodsOutside,
} from "../../test/trust/attestation-certificate-periods.fixture.js";
import type { ValidityPeriod } from "../shared/utils/certificate-validity.util.js";
import {
    credentialIssuerServiceTypes,
    ServiceTypeIdentifiers,
    type TrustedEntity,
    walletAttestationSignerServiceTypes,
} from "./types.js";
import {
    type ServiceTypeFilter,
    X509ValidationService,
} from "./x509-validation.service.js";

const PID_ISSUANCE = "http://uri.etsi.org/19602/SvcType/PID/Issuance";
const PID_REVOCATION = "http://uri.etsi.org/19602/SvcType/PID/Revocation";
const EAA_ISSUANCE = "http://uri.etsi.org/19602/SvcType/EAA/Issuance";
const EAA_REVOCATION = "http://uri.etsi.org/19602/SvcType/EAA/Revocation";

function entity(
    entityId: string,
    services: Array<[serviceTypeIdentifier: string, certValue: string]>,
): TrustedEntity {
    return {
        entityId,
        services: services.map(([serviceTypeIdentifier, certValue]) => ({
            serviceTypeIdentifier,
            certValue,
        })),
    };
}

const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

async function selfSigned(name: string, ca: boolean) {
    const keys = (await crypto.subtle.generateKey(algorithm, true, [
        "sign",
        "verify",
    ])) as CryptoKeyPair;
    return x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "01",
        name: `CN=${name}`,
        notBefore: new Date(Date.now() - 60_000),
        notAfter: new Date(Date.now() + 3_600_000),
        keys,
        signingAlgorithm: algorithm,
        extensions: [new x509.BasicConstraintsExtension(ca, 0, true)],
    });
}

const der = (cert: x509.X509Certificate) =>
    Buffer.from(cert.rawData).toString("base64");

describe("X509ValidationService.anchorCertValuesFor", () => {
    const service = new X509ValidationService();
    const entities = [
        entity("a", [
            [PID_ISSUANCE, "a-issuance"],
            [PID_REVOCATION, "a-revocation"],
        ]),
        entity("b", [
            [EAA_REVOCATION, "b-revocation"],
            [EAA_ISSUANCE, "b-issuance"],
        ]),
    ];
    const order = (filter: ServiceTypeFilter) =>
        service
            .anchorCertValuesFor(entities, filter)
            .map(({ certValue }) => certValue);

    it("lists the services of the requested types first, keeping trust-list order in both groups", () => {
        expect(order([PID_REVOCATION, EAA_REVOCATION])).toEqual([
            "a-revocation",
            "b-revocation",
            "a-issuance",
            "b-issuance",
        ]);
        expect(order(credentialIssuerServiceTypes)).toEqual([
            "a-issuance",
            "b-issuance",
            "a-revocation",
            "b-revocation",
        ]);
    });

    it("matches a listed service type identifier exactly", () => {
        expect(order([EAA_REVOCATION])).toEqual([
            "b-revocation",
            "a-issuance",
            "a-revocation",
            "b-issuance",
        ]);
    });

    it("lists the services of the listed types first", () => {
        const walletEntities = [
            entity("provider", [
                [ServiceTypeIdentifiers.WalletSolutionRevocation, "revocation"],
                [ServiceTypeIdentifiers.WalletSolutionIssuance, "issuance"],
                [ServiceTypeIdentifiers.WalletSolution, "base"],
            ]),
        ];
        expect(
            service
                .anchorCertValuesFor(
                    walletEntities,
                    walletAttestationSignerServiceTypes,
                )
                .map(({ certValue }) => certValue),
        ).toEqual(["issuance", "base", "revocation"]);
    });

    it("returns every certificate, also when no service matches", () => {
        expect(order(["http://uri.etsi.org/19602/SvcType/Unknown"])).toEqual([
            "a-issuance",
            "a-revocation",
            "b-revocation",
            "b-issuance",
        ]);
        expect(
            service.anchorCertValuesFor([], credentialIssuerServiceTypes),
        ).toEqual([]);
    });
});

describe("X509ValidationService.pathMatchesTrustedEntities with a list of service types", () => {
    const service = new X509ValidationService();
    const providerCa = () => selfSigned("Wallet Provider CA", true);

    const listedAs = (ca: x509.X509Certificate, serviceType: string) =>
        entity("provider", [[serviceType, der(ca)]]);

    it.each([
        ServiceTypeIdentifiers.WalletSolution,
        ServiceTypeIdentifiers.WalletSolutionIssuance,
    ])("matches a certificate listed as %s", async (serviceType) => {
        const ca = await providerCa();
        await expect(
            service.pathMatchesTrustedEntities(
                [ca],
                [listedAs(ca, serviceType)],
                "leaf",
                walletAttestationSignerServiceTypes,
            ),
        ).resolves.not.toBeNull();
    });

    it("does not match a certificate listed only as WalletSolution/Revocation", async () => {
        const ca = await providerCa();
        const revocationOnly = listedAs(
            ca,
            ServiceTypeIdentifiers.WalletSolutionRevocation,
        );

        await expect(
            service.pathMatchesTrustedEntities(
                [ca],
                [revocationOnly],
                "leaf",
                walletAttestationSignerServiceTypes,
            ),
        ).resolves.toBeNull();
    });
});

describe("X509ValidationService.pathMatchesTrustedEntities revocation pairing", () => {
    const service = new X509ValidationService();

    it("names the revocation certificate paired with the matched issuance service", async () => {
        const issuerCa = await selfSigned("PID Provider CA", true);
        const eaaRevocation = await selfSigned("EAA Status Signer", false);
        const pidRevocation = await selfSigned("PID Status Signer", false);

        const match = await service.pathMatchesTrustedEntities(
            [issuerCa],
            [
                entity("pid-provider", [
                    [ServiceTypeIdentifiers.EaaRevocation, der(eaaRevocation)],
                    [ServiceTypeIdentifiers.PIDIssuance, der(issuerCa)],
                    [ServiceTypeIdentifiers.PIDRevocation, der(pidRevocation)],
                ]),
            ],
            "leaf",
            credentialIssuerServiceTypes,
        );

        expect(match?.issuanceServiceType).toBe(
            ServiceTypeIdentifiers.PIDIssuance,
        );
        expect(match?.revocationThumbprint).toBe(
            Buffer.from(await pidRevocation.getThumbprint("SHA-256")).toString(
                "hex",
            ),
        );
    });
});

describe("X509ValidationService.pathMatchesTrustedEntities with the credential issuer types", () => {
    const service = new X509ValidationService();
    const ca = (name: string) => selfSigned(name, true);

    it.each([
        ServiceTypeIdentifiers.WalletSolutionIssuance,
        "http://uri.etsi.org/19602/SvcType/WRPAC/Issuance",
    ])(
        "does not match a %s certificate of a PID provider",
        async (serviceType) => {
            const pidCa = await ca("PID Provider CA");
            const otherCa = await ca("Other CA");

            await expect(
                service.pathMatchesTrustedEntities(
                    [otherCa],
                    [
                        entity("pid-provider", [
                            [ServiceTypeIdentifiers.PIDIssuance, der(pidCa)],
                            [serviceType, der(otherCa)],
                        ]),
                    ],
                    "leaf",
                    credentialIssuerServiceTypes,
                ),
            ).resolves.toBeNull();
        },
    );
});

describe("X509ValidationService.matchesStatusListSigner", () => {
    const service = new X509ValidationService();

    /** A PID provider that also issues Pub-EAAs and runs a wallet solution. */
    async function provider() {
        const certs = {
            pidIssuance: await selfSigned("PID Issuance CA", true),
            pidRevocation: await selfSigned("PID Status Signer", false),
            pubEaaIssuance: await selfSigned("Pub-EAA Issuance CA", true),
            walletRevocation: await selfSigned("Wallet Status Signer", false),
        };
        const trustedEntity = entity("provider", [
            [ServiceTypeIdentifiers.PIDIssuance, der(certs.pidIssuance)],
            [ServiceTypeIdentifiers.PIDRevocation, der(certs.pidRevocation)],
            [ServiceTypeIdentifiers.PubEaaIssuance, der(certs.pubEaaIssuance)],
            [
                ServiceTypeIdentifiers.WalletSolutionRevocation,
                der(certs.walletRevocation),
            ],
        ]);
        return { certs, trustedEntity };
    }

    async function matchedWith(
        trustedEntity: TrustedEntity,
        issuance: x509.X509Certificate,
    ) {
        const matched = await service.pathMatchesTrustedEntities(
            [issuance],
            [trustedEntity],
            "leaf",
            credentialIssuerServiceTypes,
        );
        expect(matched).not.toBeNull();
        return matched!;
    }

    it("accepts the PID/Revocation signer for a PID issuer, and no other revocation service", async () => {
        const { certs, trustedEntity } = await provider();
        const matched = await matchedWith(trustedEntity, certs.pidIssuance);

        await expect(
            service.matchesStatusListSigner(
                [certs.pidRevocation],
                matched,
                "leaf",
            ),
        ).resolves.toBe(true);
        await expect(
            service.matchesStatusListSigner(
                [certs.walletRevocation],
                matched,
                "leaf",
            ),
        ).resolves.toBe(false);
    });

    it("requires the matched certificate when no revocation service is paired with it", async () => {
        const { certs, trustedEntity } = await provider();
        const matched = await matchedWith(trustedEntity, certs.pubEaaIssuance);

        expect(service.statusListSigners(matched)).toEqual([
            {
                serviceTypeIdentifier: ServiceTypeIdentifiers.PubEaaIssuance,
                certValue: der(certs.pubEaaIssuance),
            },
        ]);
        await expect(
            service.matchesStatusListSigner(
                [certs.pubEaaIssuance],
                matched,
                "leaf",
            ),
        ).resolves.toBe(true);
        await expect(
            service.matchesStatusListSigner(
                [certs.pidRevocation],
                matched,
                "leaf",
            ),
        ).resolves.toBe(false);
    });
});

describe("X509ValidationService.isTimeValid", () => {
    const second = 1000;

    it("accepts both ends of the validity period and nothing outside it", async () => {
        const service = new X509ValidationService();
        const cert = await selfSigned("Issuer", false);
        const { notBefore, notAfter } = cert;

        expect(service.isTimeValid(cert, notBefore)).toBe(true);
        expect(service.isTimeValid(cert, notAfter)).toBe(true);
        expect(
            service.isTimeValid(cert, new Date(notBefore.getTime() - second)),
        ).toBe(false);
        expect(
            service.isTimeValid(cert, new Date(notAfter.getTime() + second)),
        ).toBe(false);
    });
});

describe("X509ValidationService.matchAttestationSigner validity periods", () => {
    const service = new X509ValidationService();
    const second = 1000;
    const hour = 3_600_000;

    async function keys() {
        return (await crypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ])) as CryptoKeyPair;
    }

    function ca(
        serialNumber: string,
        caKeys: CryptoKeyPair,
        period: ValidityPeriod = currentPeriod(),
        name = "CN=Wallet Provider CA",
    ) {
        return x509.X509CertificateGenerator.createSelfSigned({
            serialNumber,
            name,
            ...period,
            keys: caKeys,
            signingAlgorithm: algorithm,
            extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
        });
    }

    async function issued(
        serialNumber: string,
        subject: string,
        issuer: x509.X509Certificate,
        issuerKeys: CryptoKeyPair,
        period: ValidityPeriod = currentPeriod(),
        isCa = false,
    ) {
        const subjectKeys = await keys();
        const cert = await x509.X509CertificateGenerator.create({
            serialNumber,
            subject,
            issuer: issuer.subject,
            ...period,
            publicKey: subjectKeys.publicKey,
            signingKey: issuerKeys.privateKey,
            signingAlgorithm: algorithm,
            extensions: isCa
                ? [new x509.BasicConstraintsExtension(true, 0, true)]
                : [],
        });
        return { cert, keys: subjectKeys };
    }

    /** A provider CA, listed as WalletSolution/Issuance, and a signing certificate under it. */
    async function provider(
        options: {
            caPeriod?: ValidityPeriod;
            leafPeriod?: ValidityPeriod;
        } = {},
    ) {
        const caKeys = await keys();
        const providerCa = await ca("01", caKeys, options.caPeriod);
        const { cert: leaf } = await issued(
            "02",
            "CN=Wallet Attestation Signer",
            providerCa,
            caKeys,
            options.leafPeriod,
        );
        return { providerCa, caKeys, leaf };
    }

    const listed = (...certs: x509.X509Certificate[]) => [
        entity(
            "provider",
            certs.map((cert): [string, string] => [
                ServiceTypeIdentifiers.WalletSolutionIssuance,
                der(cert),
            ]),
        ),
    ];

    const thumbprint = async (cert: x509.X509Certificate) =>
        Buffer.from(await cert.getThumbprint("SHA-256")).toString("hex");

    it("accepts a path whose certificates are all valid", async () => {
        const { providerCa, leaf } = await provider();

        await expect(
            service.matchAttestationSigner([der(leaf)], listed(providerCa)),
        ).resolves.toMatchObject({ matchMode: "ca" });
    });

    for (const state of outsideStates) {
        it(`rejects a signing certificate that is ${state}`, async () => {
            const { providerCa, leaf } = await provider({
                leafPeriod: periodsOutside[state](),
            });

            await expect(
                service.matchAttestationSigner([der(leaf)], listed(providerCa)),
            ).rejects.toThrow(certificateFailure("Signing", state));
        });

        it(`rejects a listed CA that is ${state}`, async () => {
            const { providerCa, leaf } = await provider({
                caPeriod: periodsOutside[state](),
            });

            await expect(
                service.matchAttestationSigner([der(leaf)], listed(providerCa)),
            ).rejects.toThrow(certificateFailure("Trust list", state));
        });

        it(`rejects an intermediate certificate that is ${state}`, async () => {
            const rootKeys = await keys();
            const root = await ca("01", rootKeys);
            const intermediate = await issued(
                "02",
                "CN=Wallet Provider Intermediate CA",
                root,
                rootKeys,
                periodsOutside[state](),
                true,
            );
            const { cert: leaf } = await issued(
                "03",
                "CN=Wallet Attestation Signer",
                intermediate.cert,
                intermediate.keys,
            );

            await expect(
                service.matchAttestationSigner(
                    [der(leaf), der(intermediate.cert)],
                    listed(root),
                ),
            ).rejects.toThrow(certificateFailure("Intermediate", state));
        });

        it(`rejects a pinned signing certificate that is ${state}`, async () => {
            const pinned = await x509.X509CertificateGenerator.createSelfSigned(
                {
                    serialNumber: "01",
                    name: "CN=Pinned Wallet Attestation Signer",
                    ...periodsOutside[state](),
                    keys: await keys(),
                    signingAlgorithm: algorithm,
                    extensions: [
                        new x509.BasicConstraintsExtension(false, 0, true),
                    ],
                },
            );

            await expect(
                service.matchAttestationSigner([der(pinned)], listed(pinned)),
            ).rejects.toThrow(certificateFailure("Signing", state));
        });
    }

    it("names the period and the time of the check", async () => {
        const { providerCa, leaf } = await provider({
            caPeriod: {
                notBefore: new Date("2025-01-01T00:00:00Z"),
                notAfter: new Date("2030-01-01T00:00:00Z"),
            },
            leafPeriod: {
                notBefore: new Date("2026-01-01T00:00:00Z"),
                notAfter: new Date("2026-06-01T00:00:00Z"),
            },
        });

        await expect(
            service.matchAttestationSigner([der(leaf)], listed(providerCa), {
                now: new Date("2026-07-01T00:00:00Z"),
            }),
        ).rejects.toThrow(
            "Signing certificate has expired (notAfter 2026-06-01T00:00:00.000Z, checked at 2026-07-01T00:00:00.000Z)",
        );
        await expect(
            service.matchAttestationSigner([der(leaf)], listed(providerCa), {
                now: new Date("2025-12-01T00:00:00Z"),
            }),
        ).rejects.toThrow(
            "Signing certificate is not yet valid (notBefore 2026-01-01T00:00:00.000Z, checked at 2025-12-01T00:00:00.000Z)",
        );
    });

    it("accepts both ends of a validity period", async () => {
        // The CA's period is wider, so only the signing certificate's ends
        // are at stake.
        const { providerCa, leaf } = await provider({
            caPeriod: {
                notBefore: new Date(Date.now() - 2 * hour),
                notAfter: new Date(Date.now() + 2 * hour),
            },
        });
        const match = (now: Date) =>
            service.matchAttestationSigner([der(leaf)], listed(providerCa), {
                now,
            });

        await expect(match(leaf.notBefore)).resolves.not.toBeNull();
        await expect(match(leaf.notAfter)).resolves.not.toBeNull();
        await expect(
            match(new Date(leaf.notBefore.getTime() - second)),
        ).rejects.toThrow("Signing certificate is not yet valid");
        await expect(
            match(new Date(leaf.notAfter.getTime() + second)),
        ).rejects.toThrow("Signing certificate has expired");
    });

    it("does not check a certificate above a pinned signing certificate", async () => {
        const caKeys = await keys();
        const expiredCa = await ca("01", caKeys, periodsOutside.expired());
        const { cert: leaf } = await issued(
            "02",
            "CN=Wallet Attestation Signer",
            expiredCa,
            caKeys,
        );

        await expect(
            service.matchAttestationSigner(
                [der(leaf), der(expiredCa)],
                listed(leaf),
            ),
        ).resolves.toMatchObject({ matchMode: "leaf-pinned" });
    });

    describe("with a CA renewed with the same subject and key", () => {
        async function renewal() {
            const caKeys = await keys();
            const expiredCa = await ca("01", caKeys, periodsOutside.expired());
            const renewedCa = await ca("02", caKeys);
            const { cert: leaf } = await issued(
                "03",
                "CN=Wallet Attestation Signer",
                renewedCa,
                caKeys,
            );
            return { expiredCa, renewedCa, leaf };
        }

        for (const order of ["expired first", "renewed first"] as const) {
            for (const x5c of ["without the CA", "with the expired CA"]) {
                it(`ends the path at the renewed CA while the expired one is still listed (${order}, x5c ${x5c})`, async () => {
                    const { expiredCa, renewedCa, leaf } = await renewal();

                    const matched = await service.matchAttestationSigner(
                        x5c === "with the expired CA"
                            ? [der(leaf), der(expiredCa)]
                            : [der(leaf)],
                        listed(
                            ...(order === "expired first"
                                ? [expiredCa, renewedCa]
                                : [renewedCa, expiredCa]),
                        ),
                    );

                    expect(matched?.issuanceThumbprint).toBe(
                        await thumbprint(renewedCa),
                    );
                });
            }
        }

        it("ends the path at the listed renewal when x5c carries the expired CA the list no longer names", async () => {
            const { expiredCa, renewedCa, leaf } = await renewal();

            const matched = await service.matchAttestationSigner(
                [der(leaf), der(expiredCa)],
                listed(renewedCa),
            );

            expect(matched?.issuanceThumbprint).toBe(
                await thumbprint(renewedCa),
            );
        });
    });

    it("rejects an expired attestation CA although a revocation CA with its subject and key is valid", async () => {
        const { providerCa, caKeys, leaf } = await provider({
            caPeriod: periodsOutside.expired(),
        });
        const revocationCa = await ca("09", caKeys);

        await expect(
            service.matchAttestationSigner(
                [der(leaf)],
                [
                    entity("provider", [
                        [
                            ServiceTypeIdentifiers.WalletSolutionRevocation,
                            der(revocationCa),
                        ],
                        [
                            ServiceTypeIdentifiers.WalletSolutionIssuance,
                            der(providerCa),
                        ],
                    ]),
                ],
            ),
        ).rejects.toThrow(certificateFailure("Trust list", "expired"));
    });

    it("does not let a revocation CA with the subject and key of a presented intermediate take its place", async () => {
        const rootKeys = await keys();
        const root = await ca("01", rootKeys);
        const intermediate = await issued(
            "02",
            "CN=Wallet Provider Intermediate CA",
            root,
            rootKeys,
            currentPeriod(),
            true,
        );
        const revocationTwin = await ca(
            "03",
            intermediate.keys,
            currentPeriod(),
            intermediate.cert.subject,
        );
        const { cert: leaf } = await issued(
            "04",
            "CN=Wallet Attestation Signer",
            intermediate.cert,
            intermediate.keys,
        );

        const matched = await service.matchAttestationSigner(
            [der(leaf), der(intermediate.cert)],
            [
                entity("provider", [
                    [ServiceTypeIdentifiers.WalletSolutionIssuance, der(root)],
                    [
                        ServiceTypeIdentifiers.WalletSolutionRevocation,
                        der(revocationTwin),
                    ],
                ]),
            ],
        );

        expect(matched?.issuanceThumbprint).toBe(await thumbprint(root));
    });

    it("skips listed certificates that cannot be parsed when it orders the anchors", async () => {
        const { providerCa, leaf } = await provider();

        await expect(
            service.matchAttestationSigner(
                [der(leaf)],
                [
                    ...listed(providerCa),
                    entity("other", [
                        [ServiceTypeIdentifiers.WalletSolutionIssuance, ""],
                        [
                            ServiceTypeIdentifiers.WalletSolutionRevocation,
                            "AAAA",
                        ],
                    ]),
                ],
            ),
        ).resolves.toMatchObject({ matchMode: "ca" });
    });

    it("leaves the periods unchecked when told to", async () => {
        const { providerCa, leaf } = await provider({
            caPeriod: periodsOutside.expired(),
            leafPeriod: periodsOutside.expired(),
        });

        await expect(
            service.matchAttestationSigner([der(leaf)], listed(providerCa), {
                ignoreValidityPeriods: true,
            }),
        ).resolves.toMatchObject({ matchMode: "ca" });
    });
});
