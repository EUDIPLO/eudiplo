import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
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
