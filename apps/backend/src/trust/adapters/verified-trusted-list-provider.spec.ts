import { beforeAll, describe, expect, it, vi } from "vitest";
import { generateSelfSignedCertificate } from "../../../test/issuance/attestation-trust-helpers.js";
import {
    buildSignedTrustedList,
    EAA_SERVICE_TYPE,
    SERVICE_STATUS,
    TSL_TYPE,
} from "../../../test/trust/trusted-list.fixture.js";
import { VerifiedTrustedListProvider } from "./verified-trusted-list-provider.js";

type Certificate = Awaited<ReturnType<typeof generateSelfSignedCertificate>>;

describe("VerifiedTrustedListProvider", () => {
    let lotlSigner: Certificate;
    let listSigner: Certificate;
    let issuer: Certificate;
    const der = (cert: Certificate) => cert.certificate.toString("base64");

    beforeAll(async () => {
        [lotlSigner, listSigner, issuer] = await Promise.all([
            generateSelfSignedCertificate(),
            generateSelfSignedCertificate(),
            generateSelfSignedCertificate(),
        ]);
    });

    const serving = (body: string) => {
        const get = vi.fn().mockResolvedValue({ body });
        return { provider: new VerifiedTrustedListProvider({ get }), get };
    };

    it("returns the granted qualified QEAA services of a national list", async () => {
        const xml = await buildSignedTrustedList(
            {
                sequenceNumber: 7,
                providers: [
                    {
                        name: "QP-A",
                        services: [{ certificates: [issuer.certificate] }],
                    },
                    {
                        name: "QP-W",
                        services: [
                            {
                                certificates: [listSigner.certificate],
                                status: SERVICE_STATUS.withdrawn,
                            },
                        ],
                    },
                    {
                        name: "QP-N",
                        services: [
                            {
                                certificates: [lotlSigner.certificate],
                                type: EAA_SERVICE_TYPE.notQualified,
                                status: SERVICE_STATUS.recognisedAtNationalLevel,
                            },
                        ],
                    },
                ],
            },
            listSigner,
        );
        const { provider, get } = serving(xml);

        const list = await provider.loadVerified({
            format: "trusted-list",
            url: "https://tl.example/de.xml",
            signingCertificates: [der(listSigner)],
        });

        expect(list).toEqual({
            nextUpdate: expect.stringMatching(/Z$/),
            sequenceNumber: 7,
            entities: [
                {
                    entityId: "QP-A",
                    services: [
                        {
                            serviceTypeIdentifier: EAA_SERVICE_TYPE.qualified,
                            certValue: der(issuer),
                        },
                    ],
                },
            ],
        });
        expect(get).toHaveBeenCalledWith(
            "https://tl.example/de.xml",
            expect.objectContaining({ maxBytes: 10 * 1024 * 1024 }),
        );
    });

    it("returns the national lists a list of trusted lists points to", async () => {
        const xml = await buildSignedTrustedList(
            {
                tslType: TSL_TYPE.EUlistofthelists,
                pointers: [
                    {
                        location: "https://tl.example/de.xml",
                        signers: [listSigner.certificate],
                    },
                    // The PDF version of the same list is not followed.
                    {
                        location: "https://tl.example/de.pdf",
                        signers: [listSigner.certificate],
                        mimeType: "application/pdf",
                    },
                    {
                        location: "https://tl.example/fr.xml",
                        signers: [issuer.certificate],
                        territory: "FR",
                    },
                    {
                        location: "https://tl.example/lotl.xml",
                        signers: [lotlSigner.certificate],
                        tslType: TSL_TYPE.EUlistofthelists,
                    },
                ],
            },
            lotlSigner,
        );
        const { provider } = serving(xml);

        await expect(
            provider.loadVerified({
                format: "trusted-list",
                url: "https://tl.example/lotl.xml",
                signingCertificates: [der(lotlSigner)],
                schemeTerritories: ["de"],
            }),
        ).resolves.toMatchObject({
            entities: [],
            pointers: [
                {
                    format: "trusted-list",
                    url: "https://tl.example/de.xml",
                    signingCertificates: [der(listSigner)],
                },
            ],
        });
    });

    it("refuses a list signed by another key than its signing certificates", async () => {
        const xml = await buildSignedTrustedList({}, issuer);
        const { provider } = serving(xml);

        await expect(
            provider.loadVerified({
                format: "trusted-list",
                url: "https://tl.example/de.xml",
                signingCertificates: [der(listSigner)],
            }),
        ).rejects.toThrow(
            "Trusted List https://tl.example/de.xml is not a Trusted List signed by one of its signing certificates",
        );
    });

    it("refuses a list whose signature uses an XPath transform before checking it", async () => {
        const xml = (await buildSignedTrustedList({}, listSigner)).replace(
            '<ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>',
            '<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>count(//*) &gt; 0</ds:XPath></ds:Transform>',
        );
        const { provider } = serving(xml);

        await expect(
            provider.loadVerified({
                format: "trusted-list",
                url: "https://tl.example/de.xml",
                signingCertificates: [der(listSigner)],
            }),
        ).rejects.toThrow(
            'Trusted List https://tl.example/de.xml is refused before its signature is checked: its signature uses the transform "http://www.w3.org/TR/1999/REC-xpath-19991116"',
        );
    });

    // A closed list has an empty NextUpdate; verification then discards it.
    it("reports no NextUpdate for a closed list", async () => {
        const { provider } = serving(
            await buildSignedTrustedList({ nextUpdate: null }, listSigner),
        );

        await expect(
            provider.loadVerified({
                format: "trusted-list",
                url: "https://tl.example/de.xml",
                signingCertificates: [der(listSigner)],
            }),
        ).resolves.toMatchObject({ nextUpdate: undefined, entities: [] });
    });

    it("refuses a list without signing certificates", async () => {
        const { provider } = serving(
            await buildSignedTrustedList({}, listSigner),
        );

        await expect(
            provider.loadVerified({
                format: "trusted-list",
                url: "https://tl.example/de.xml",
            }),
        ).rejects.toThrow(
            "is not a Trusted List signed by one of its signing certificates",
        );
    });

    it("refuses a list that declares a DOCTYPE before parsing it", async () => {
        const xml = await buildSignedTrustedList(
            { prolog: '<!DOCTYPE TrustServiceStatusList [<!ENTITY a "a">]>\n' },
            listSigner,
        );
        const { provider } = serving(xml);

        await expect(
            provider.loadVerified({
                format: "trusted-list",
                url: "https://tl.example/de.xml",
                signingCertificates: [der(listSigner)],
            }),
        ).rejects.toThrow("declares a DOCTYPE");
    });

    it("names the list when it cannot be fetched", async () => {
        const get = vi.fn().mockRejectedValue(new Error("status code 404"));
        const provider = new VerifiedTrustedListProvider({ get });

        await expect(
            provider.loadVerified({
                format: "trusted-list",
                url: "https://tl.example/de.xml",
                signingCertificates: [der(listSigner)],
            }),
        ).rejects.toThrow(
            "Failed to fetch Trusted List from https://tl.example/de.xml: status code 404",
        );
    });
});
