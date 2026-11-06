import type { LoTE } from "@owf/eudi-lote";
import { describe, expect, it } from "vitest";
import { LoteParserService } from "./lote-parser.service.js";
import { ServiceTypeIdentifiers } from "./types.js";

const WITHDRAWN =
    "http://uri.etsi.org/19602/PubEAAProvidersList/SvcStatus/withdrawn";
const NOTIFIED =
    "http://uri.etsi.org/19602/PubEAAProvidersList/SvcStatus/notified";

function service(type: string, cert: string, status?: string) {
    return {
        ServiceInformation: {
            ServiceTypeIdentifier: type,
            ServiceName: [{ lang: "en", value: type }],
            ServiceDigitalIdentity: { X509Certificates: [{ val: cert }] },
            ...(status ? { ServiceStatus: status } : {}),
        },
    };
}

function lote(...entities: Array<{ name: string; services: unknown[] }>): LoTE {
    return {
        ListAndSchemeInformation: {
            NextUpdate: "2030-01-01T00:00:00Z",
            ListIssueDateTime: "2026-01-01T00:00:00Z",
            SchemeTerritory: "EU",
        },
        TrustedEntitiesList: entities.map(({ name, services }) => ({
            TrustedEntityInformation: { TEName: [{ lang: "en", value: name }] },
            TrustedEntityServices: services,
        })),
    } as unknown as LoTE;
}

describe("LoteParserService.parse", () => {
    const parser = new LoteParserService();

    it("leaves out services whose status withdraws them", () => {
        const { entities } = parser.parse(
            lote({
                name: "Public body",
                services: [
                    service(
                        ServiceTypeIdentifiers.PubEaaIssuance,
                        "withdrawn-issuance",
                        WITHDRAWN,
                    ),
                    service(
                        ServiceTypeIdentifiers.PubEaaRevocation,
                        "notified-revocation",
                        NOTIFIED,
                    ),
                ],
            }),
        );

        expect(entities).toEqual([
            {
                entityId: "Public body",
                services: [
                    {
                        serviceTypeIdentifier:
                            ServiceTypeIdentifiers.PubEaaRevocation,
                        certValue: "notified-revocation",
                    },
                ],
            },
        ]);
    });

    it("drops an entity whose services are all withdrawn", () => {
        const { entities } = parser.parse(
            lote(
                {
                    name: "Withdrawn body",
                    services: [
                        service(
                            ServiceTypeIdentifiers.PubEaaIssuance,
                            "a",
                            WITHDRAWN,
                        ),
                        service(
                            ServiceTypeIdentifiers.EaaIssuance,
                            "b",
                            "http://uri.etsi.org/19602/commons/schemeApprovalWithdrawn",
                        ),
                    ],
                },
                {
                    name: "Listed body",
                    services: [
                        service(ServiceTypeIdentifiers.PubEaaIssuance, "c"),
                    ],
                },
            ),
        );

        expect(entities.map((e) => e.entityId)).toEqual(["Listed body"]);
    });
});
