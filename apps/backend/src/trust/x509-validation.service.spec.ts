import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import {
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

    it("lists the services of the requested type first, keeping trust-list order in both groups", () => {
        expect(order("/Revocation")).toEqual([
            "a-revocation",
            "b-revocation",
            "a-issuance",
            "b-issuance",
        ]);
        expect(order("/Issuance")).toEqual([
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
        expect(order("/Unknown")).toEqual([
            "a-issuance",
            "a-revocation",
            "b-revocation",
            "b-issuance",
        ]);
        expect(service.anchorCertValuesFor([], "/Issuance")).toEqual([]);
    });
});

describe("X509ValidationService.pathMatchesTrustedEntities with a list of service types", () => {
    const service = new X509ValidationService();
    const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

    async function providerCa() {
        const keys = (await crypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ])) as CryptoKeyPair;
        return x509.X509CertificateGenerator.createSelfSigned({
            serialNumber: "01",
            name: "CN=Wallet Provider CA",
            notBefore: new Date(Date.now() - 60_000),
            notAfter: new Date(Date.now() + 3_600_000),
            keys,
            signingAlgorithm: algorithm,
            extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
        });
    }

    const listedAs = (ca: x509.X509Certificate, serviceType: string) =>
        entity("provider", [
            [serviceType, Buffer.from(ca.rawData).toString("base64")],
        ]);

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
