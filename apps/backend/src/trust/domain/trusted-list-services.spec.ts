import { describe, expect, it } from "vitest";
import {
    isListOfTrustedLists,
    qeaaProvidersOf,
    type TrustedList,
    type TrustedListPointer,
    trustedListPointersToFollow,
} from "./trusted-list-services.js";

const QEAA = "http://uri.etsi.org/TrstSvc/Svctype/EAA/Q";
const GRANTED = "http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/granted";
const EU_GENERIC = "http://uri.etsi.org/TrstSvc/TrustedList/TSLType/EUgeneric";
const LOTL = "http://uri.etsi.org/TrstSvc/TrustedList/TSLType/EUlistofthelists";

const service = (
    certificate: string | undefined,
    overrides: Partial<
        TrustedList["providers"][number]["services"][number]
    > = {},
) => ({
    serviceTypeIdentifier: QEAA,
    serviceStatus: GRANTED,
    digitalIdentities: [
        certificate ? { certificate } : { subjectName: "CN=x" },
    ],
    ...overrides,
});

const trustedList = (overrides: Partial<TrustedList>): TrustedList => ({
    tslType: EU_GENERIC,
    providers: [],
    ...overrides,
});

describe("qeaaProvidersOf", () => {
    it("keeps only granted qualified QEAA services with a certificate, per provider", () => {
        const list = trustedList({
            providers: [
                {
                    name: "QP-A",
                    services: [
                        service("a1"),
                        service(undefined),
                        // A withdrawn service adds no anchor.
                        service("a-withdrawn", {
                            serviceStatus:
                                "http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/withdrawn",
                        }),
                    ],
                },
                {
                    name: "QP-N",
                    services: [
                        service("n1", {
                            serviceTypeIdentifier:
                                "http://uri.etsi.org/TrstSvc/Svctype/EAA",
                            serviceStatus:
                                "http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/recognisedatnationallevel",
                        }),
                        service("n2", {
                            serviceTypeIdentifier:
                                "http://uri.etsi.org/TrstSvc/Svctype/CA/QC",
                        }),
                        // Statuses compare exactly, as the types do.
                        service("n3", {
                            serviceStatus:
                                "https://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/granted",
                        }),
                    ],
                },
                {
                    name: "QP-B",
                    services: [
                        {
                            ...service("b1"),
                            digitalIdentities: [
                                { certificate: "b1" },
                                { certificate: "b2" },
                            ],
                        },
                    ],
                },
            ],
        });

        expect(qeaaProvidersOf(list)).toEqual([
            {
                entityId: "QP-A",
                services: [{ serviceTypeIdentifier: QEAA, certValue: "a1" }],
            },
            {
                entityId: "QP-B",
                services: [
                    { serviceTypeIdentifier: QEAA, certValue: "b1" },
                    { serviceTypeIdentifier: QEAA, certValue: "b2" },
                ],
            },
        ]);
    });
});

describe("trustedListPointersToFollow", () => {
    const pointer = (
        overrides: Partial<TrustedListPointer> & { mimeType?: string },
    ) =>
        ({
            location: "https://tl.example/de.xml",
            tslType: EU_GENERIC,
            schemeTerritory: "DE",
            digitalIdentities: [
                { certificate: "de-signer" },
                { subjectName: "CN=x" },
            ],
            ...overrides,
        }) as TrustedListPointer;

    const lotl = (pointers: TrustedListPointer[]) =>
        trustedList({ tslType: LOTL, pointersToOtherLists: pointers });

    it("follows national lists in XML with the certificates the LOTL names for them", () => {
        const list = lotl([
            pointer({}),
            pointer({ location: "https://tl.example/de.xml" }),
            pointer({ location: "https://tl.example/lotl.xml", tslType: LOTL }),
            pointer({
                location: "https://tl.example/de.pdf",
                mimeType: "application/pdf",
            }),
            pointer({
                location: "https://tl.example/fr.xml",
                schemeTerritory: "FR",
                mimeType: "application/vnd.etsi.tsl+xml",
                digitalIdentities: [{ certificate: "fr-signer" }],
            }),
        ]);

        expect(isListOfTrustedLists(list)).toBe(true);
        expect(trustedListPointersToFollow(list)).toEqual([
            {
                format: "trusted-list",
                url: "https://tl.example/de.xml",
                signingCertificates: ["de-signer"],
            },
            {
                format: "trusted-list",
                url: "https://tl.example/fr.xml",
                signingCertificates: ["fr-signer"],
            },
        ]);
    });

    it("follows only the given territories, compared case-insensitively", () => {
        const list = lotl([
            pointer({}),
            pointer({
                location: "https://tl.example/fr.xml",
                schemeTerritory: "FR",
            }),
            pointer({
                location: "https://tl.example/none.xml",
                schemeTerritory: undefined,
            }),
        ]);

        expect(
            trustedListPointersToFollow(list, ["fr"]).map((ref) => ref.url),
        ).toEqual(["https://tl.example/fr.xml"]);
    });

    it("treats a national list as no list of trusted lists", () => {
        expect(isListOfTrustedLists(trustedList({}))).toBe(false);
    });
});
