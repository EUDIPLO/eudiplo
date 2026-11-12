import { Logger } from "@nestjs/common";
import type { LoTE } from "@owf/eudi-lote";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoteTypes, ServiceStatuses } from "./domain/lote-profiles.js";
import { LoteParserService } from "./lote-parser.service.js";
import { ServiceTypeIdentifiers } from "./types.js";

const LIST = "https://trust.example.org/lists/issuers.jwt";

function service(type: string | undefined, cert: string, status?: string) {
    return {
        ServiceInformation: {
            ...(type ? { ServiceTypeIdentifier: type } : {}),
            ServiceName: [{ lang: "en", value: type ?? "Service" }],
            ServiceDigitalIdentity: { X509Certificates: [{ val: cert }] },
            ...(status ? { ServiceStatus: status } : {}),
        },
    };
}

function lote(
    loteType: string | undefined,
    ...entities: Array<{ name: string; services: unknown[] }>
): LoTE {
    return {
        ListAndSchemeInformation: {
            LoTESequenceNumber: 7,
            NextUpdate: "2030-01-01T00:00:00Z",
            ListIssueDateTime: "2026-01-01T00:00:00Z",
            SchemeTerritory: "EU",
            ...(loteType ? { LoTEType: loteType } : {}),
        },
        TrustedEntitiesList: entities.map(({ name, services }) => ({
            TrustedEntityInformation: { TEName: [{ lang: "en", value: name }] },
            TrustedEntityServices: services,
        })),
    } as unknown as LoTE;
}

describe("LoteParserService.parse", () => {
    const parser = new LoteParserService();
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /** The single warning of the last parse. */
    function warning(): string {
        expect(warn).toHaveBeenCalledOnce();
        return String(warn.mock.calls[0][0]);
    }

    it("reads the list's sequence number and NextUpdate as signed", () => {
        expect(parser.parse(lote(undefined), LIST).info).toMatchObject({
            sequenceNumber: 7,
            nextUpdate: "2030-01-01T00:00:00Z",
        });
        expect(warn).not.toHaveBeenCalled();
    });

    describe("services without ServiceTypeIdentifier", () => {
        it.each([
            [LoteTypes.PIDProviders, ServiceTypeIdentifiers.PIDIssuance],
            [
                LoteTypes.WalletProviders,
                ServiceTypeIdentifiers.WalletSolutionIssuance,
            ],
            [
                LoteTypes.PubEAAProviders,
                ServiceTypeIdentifiers.PubEaaIssuance,
                ServiceStatuses.PubEAANotified,
            ],
            [LoteTypes.EAAProviders, ServiceTypeIdentifiers.EaaIssuance],
        ])(
            "get the issuance type of a %s in which no service has a type",
            (loteType, implied, status?: string) => {
                const { entities } = parser.parse(
                    lote(
                        loteType,
                        {
                            name: "A",
                            services: [service(undefined, "a", status)],
                        },
                        {
                            name: "B",
                            services: [service(undefined, "b", status)],
                        },
                    ),
                    LIST,
                );

                expect(entities).toEqual([
                    {
                        entityId: "A",
                        services: [
                            { serviceTypeIdentifier: implied, certValue: "a" },
                        ],
                    },
                    {
                        entityId: "B",
                        services: [
                            { serviceTypeIdentifier: implied, certValue: "b" },
                        ],
                    },
                ]);
                expect(warn).not.toHaveBeenCalled();
            },
        );

        it("are left out of a list whose other services have a type", () => {
            const { entities } = parser.parse(
                lote(
                    LoteTypes.PIDProviders,
                    {
                        name: "Typed",
                        services: [
                            service(ServiceTypeIdentifiers.PIDIssuance, "t"),
                        ],
                    },
                    { name: "Untyped", services: [service(undefined, "u")] },
                ),
                LIST,
            );

            expect(entities.map((e) => e.entityId)).toEqual(["Typed"]);
            expect(warning()).toBe(
                `Trust list ${LIST}: left out 1 service(s): entity "Untyped", type (none): no ServiceTypeIdentifier, while other services of the list have one`,
            );
        });

        it.each([
            "https://scheme.example.org/LoTEType/Members",
            undefined,
            LoteTypes.WRPACProviders,
        ])(
            "are left out of a list of type %s, which implies none",
            (loteType) => {
                const { entities } = parser.parse(
                    lote(loteType, {
                        name: "Untyped",
                        services: [service(undefined, "u")],
                    }),
                    LIST,
                );

                expect(entities).toEqual([]);
                expect(warning()).toContain(
                    'entity "Untyped", type (none): no ServiceTypeIdentifier, and the list type implies none',
                );
            },
        );
    });

    describe("ServiceStatus", () => {
        it("reads notified Pub-EAA services and leaves out withdrawn and unknown ones", () => {
            const { entities } = parser.parse(
                lote(LoteTypes.PubEAAProviders, {
                    name: "Public body",
                    services: [
                        service(
                            ServiceTypeIdentifiers.PubEaaIssuance,
                            "withdrawn-issuance",
                            ServiceStatuses.PubEAAWithdrawn,
                        ),
                        service(
                            ServiceTypeIdentifiers.PubEaaIssuance,
                            "unknown-issuance",
                            ServiceStatuses.SchemeApprovalGranted,
                        ),
                        service(
                            ServiceTypeIdentifiers.PubEaaRevocation,
                            "notified-revocation",
                            ServiceStatuses.PubEAANotified,
                        ),
                    ],
                }),
                LIST,
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
            expect(warning()).toBe(
                `Trust list ${LIST}: left out 2 service(s): ` +
                    `entity "Public body", type "${ServiceTypeIdentifiers.PubEaaIssuance}", status "${ServiceStatuses.PubEAAWithdrawn}": its ServiceStatus withdraws it; ` +
                    `entity "Public body", type "${ServiceTypeIdentifiers.PubEaaIssuance}", status "${ServiceStatuses.SchemeApprovalGranted}": the list type does not approve services with this ServiceStatus`,
            );
        });

        it("reads a Pub-EAA service without status, with a warning", () => {
            const { entities } = parser.parse(
                lote(LoteTypes.PubEAAProviders, {
                    name: "Public body",
                    services: [
                        service(ServiceTypeIdentifiers.PubEaaIssuance, "i"),
                    ],
                }),
                LIST,
            );

            expect(entities).toHaveLength(1);
            expect(warning()).toBe(
                `Trust list ${LIST}: read 1 service(s) despite: entity "Public body", type "${ServiceTypeIdentifiers.PubEaaIssuance}": no ServiceStatus, which the list type requires`,
            );
        });

        it("leaves out any status in a PID providers list (Annex D)", () => {
            const { entities } = parser.parse(
                lote(
                    LoteTypes.PIDProviders,
                    {
                        name: "Listed",
                        services: [
                            service(ServiceTypeIdentifiers.PIDIssuance, "a"),
                        ],
                    },
                    {
                        name: "With status",
                        services: [
                            service(
                                ServiceTypeIdentifiers.PIDIssuance,
                                "b",
                                ServiceStatuses.SchemeApprovalGranted,
                            ),
                        ],
                    },
                ),
                LIST,
            );

            expect(entities.map((e) => e.entityId)).toEqual(["Listed"]);
            expect(warning()).toContain(
                `entity "With status", type "${ServiceTypeIdentifiers.PIDIssuance}", status "${ServiceStatuses.SchemeApprovalGranted}": the list type does not use ServiceStatus`,
            );
        });

        it("reads absent, notified and granted statuses in other lists and leaves out unknown ones", () => {
            const { entities } = parser.parse(
                lote(
                    LoteTypes.EAAProviders,
                    {
                        name: "Absent",
                        services: [
                            service(ServiceTypeIdentifiers.EaaIssuance, "a"),
                        ],
                    },
                    {
                        name: "Notified",
                        services: [
                            service(
                                ServiceTypeIdentifiers.EaaIssuance,
                                "n",
                                ServiceStatuses.PubEAANotified,
                            ),
                        ],
                    },
                    {
                        name: "Granted",
                        services: [
                            service(
                                ServiceTypeIdentifiers.EaaIssuance,
                                "g",
                                ServiceStatuses.SchemeApprovalGranted,
                            ),
                        ],
                    },
                    {
                        name: "Unknown",
                        services: [
                            service(
                                ServiceTypeIdentifiers.EaaIssuance,
                                "u",
                                "https://scheme.example.org/status/approved",
                            ),
                        ],
                    },
                ),
                LIST,
            );

            expect(entities.map((e) => e.entityId)).toEqual([
                "Absent",
                "Notified",
                "Granted",
            ]);
            expect(warning()).toContain(
                'entity "Unknown", type "http://uri.etsi.org/19602/SvcType/EAA/Issuance", status "https://scheme.example.org/status/approved": the list type does not approve services with this ServiceStatus',
            );
        });

        it("drops an entity whose services are all withdrawn", () => {
            const { entities } = parser.parse(
                lote(
                    undefined,
                    {
                        name: "Withdrawn body",
                        services: [
                            service(
                                ServiceTypeIdentifiers.PubEaaIssuance,
                                "a",
                                ServiceStatuses.PubEAAWithdrawn,
                            ),
                            service(
                                ServiceTypeIdentifiers.EaaIssuance,
                                "b",
                                ServiceStatuses.SchemeApprovalWithdrawn,
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
                LIST,
            );

            expect(entities.map((e) => e.entityId)).toEqual(["Listed body"]);
            expect(warning()).toContain("left out 2 service(s)");
        });
    });

    it("reads no certificate from an untyped service without ServiceInformation", () => {
        const { entities } = parser.parse(
            lote(LoteTypes.PIDProviders, {
                name: "Empty",
                services: [{}],
            }),
            LIST,
        );

        expect(entities).toEqual([]);
    });

    it("names at most ten services per kind in the warning", () => {
        parser.parse(
            lote(
                LoteTypes.PIDProviders,
                ...Array.from({ length: 12 }, (_, i) => ({
                    name: `E${i}`,
                    services: [
                        service(
                            ServiceTypeIdentifiers.PIDIssuance,
                            `c${i}`,
                            ServiceStatuses.SchemeApprovalWithdrawn,
                        ),
                    ],
                })),
            ),
            LIST,
        );

        expect(warning()).toContain("left out 12 service(s)");
        expect(warning()).toContain('entity "E9"');
        expect(warning()).not.toContain('entity "E10"');
        expect(warning()).toMatch(/; and 2 more$/);
    });

    it("escapes line breaks in names from the list", () => {
        parser.parse(
            lote(LoteTypes.PIDProviders, {
                name: "Evil\nTrust list x: all fine",
                services: [
                    service(
                        ServiceTypeIdentifiers.PIDIssuance,
                        "a",
                        ServiceStatuses.SchemeApprovalGranted,
                    ),
                ],
            }),
            LIST,
        );

        expect(warning()).not.toContain("\n");
        expect(warning()).toContain('entity "Evil\\nTrust list x: all fine"');
    });
});
