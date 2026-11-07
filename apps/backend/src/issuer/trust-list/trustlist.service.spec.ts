import { ConflictException, NotFoundException } from "@nestjs/common";
import type { LoTEDocument } from "@owf/eudi-lote";
import * as x509 from "@peculiar/x509";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeyUsageType } from "../../crypto/key/types/key-usage-type.js";
import { TrustListReferences } from "./application/trust-list-references.js";
import { TrustListInputError } from "./domain/trust-list-input.js";
import {
    type ManagedTrustList,
    TrustListInUseError,
    type TrustListReference,
} from "./domain/trust-list-reference.js";
import type { TrustListCreateDto } from "./dto/trust-list-create.dto.js";
import type { TrustList } from "./entities/trust-list.entity.js";
import { TrustListCreateSchema } from "./schemas/trust-list.schema.js";
import { TrustListService } from "./trustlist.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-02T12:00:00.000Z");
const inDays = (days: number) =>
    new Date(now.getTime() + days * DAY_MS).toISOString();
/** As a re-issued list publishes it: whole seconds (ETSI TS 119 602 6.1.3). */
const publishedInDays = (days: number) => inDays(days).replace(".000Z", "Z");

const entities = [{ TrustedEntityInformation: { TEName: [] } }];

function storedList(
    id: string,
    nextUpdate: string,
    overrides: Partial<TrustList> = {},
): TrustList {
    return {
        id,
        tenantId: "tenant",
        keyChainId: "trust-list-key",
        sequenceNumber: 2,
        entityConfig: [],
        jwt: `${id}-jwt-2`,
        data: {
            LoTE: {
                ListAndSchemeInformation: {
                    LoTESequenceNumber: 2,
                    ListIssueDateTime: "2026-09-01T00:00:00.000Z",
                    NextUpdate: nextUpdate,
                },
                TrustedEntitiesList: entities,
            },
        },
        ...overrides,
    } as unknown as TrustList;
}

/** A key chain certificate with usage type `trustList`. */
const trustListKey = (id: string) => ({
    id,
    keyChain: { usageType: KeyUsageType.TrustList },
});

/**
 * Service on an in-memory store whose `update` honours its WHERE criteria
 * like the database does, so compare-and-set behaviour is observable.
 */
function createService(
    rows: TrustList[],
    store = new Map(rows.map((row) => [row.id, structuredClone(row)])),
    versions: object[] = [],
    references = new TrustListReferences(),
) {
    const manager = {
        update: vi.fn(
            async (
                _entity: unknown,
                where: Pick<TrustList, "tenantId" | "id" | "sequenceNumber">,
                changes: Partial<TrustList>,
            ) => {
                const row = store.get(where.id);
                if (
                    row?.tenantId !== where.tenantId ||
                    row.sequenceNumber !== where.sequenceNumber
                ) {
                    return { affected: 0 };
                }
                Object.assign(row, structuredClone(changes));
                return { affected: 1 };
            },
        ),
        insert: vi.fn(async (_entity: unknown, value: object) => {
            versions.push(value);
        }),
    };
    const trustListRepo = {
        find: vi.fn(async () =>
            [...store.values()].map((row) => structuredClone(row)),
        ),
        findOneByOrFail: vi.fn(async ({ id }: { id: string }) =>
            structuredClone(store.get(id)),
        ),
        findOneBy: vi.fn(
            async ({ tenantId, id }: { tenantId: string; id: string }) => {
                const row = store.get(id);
                return row?.tenantId === tenantId ? structuredClone(row) : null;
            },
        ),
        existsBy: vi.fn(
            async ({ tenantId, id }: { tenantId: string; id: string }) =>
                store.get(id)?.tenantId === tenantId,
        ),
        delete: vi.fn(async ({ id }: { id: string }) => {
            store.delete(id);
        }),
        create: vi.fn((value: object) => value),
        save: vi.fn(async (value: object) => value),
        manager: {
            transaction: vi.fn(
                async (work: (m: typeof manager) => Promise<unknown>) =>
                    work(manager),
            ),
        },
    };
    const certService = {
        getCertificateById: vi
            .fn()
            .mockResolvedValue(trustListKey("trust-list-key")),
        getCertificatesByIds: vi.fn(
            async (
                _tenantId: string,
                _ids: string[],
            ): Promise<Map<string, object>> => new Map(),
        ),
        // The tenant's pick, distinct from any key chain named by ID.
        find: vi.fn().mockResolvedValue(trustListKey("tenant-trust-list-key")),
    };
    // Matches like a TypeORM `where` of plain values.
    const matches = (row: object, where: object) =>
        Object.entries(where).every(
            ([key, value]) => (row as Record<string, unknown>)[key] === value,
        );
    const trustListVersionRepo = {
        find: vi.fn(async ({ where }: { where: object }) =>
            versions.filter((version) => matches(version, where)),
        ),
        findOneBy: vi.fn(
            async (where: object) =>
                versions.find((version) => matches(version, where)) ?? null,
        ),
    };
    const service = new TrustListService(
        trustListRepo as any,
        trustListVersionRepo as any,
        {} as any,
        certService as any,
        {} as any,
        {
            findOneByOrFail: vi
                .fn()
                .mockResolvedValue({ id: "tenant", name: "Tenant" }),
        } as any,
        { register: vi.fn() } as any,
        references,
    );
    const generateJwt = vi
        .spyOn(service, "generateJwt")
        .mockImplementation(
            async (list) =>
                `${list.id}-jwt-${(list.data as LoTEDocument).LoTE.ListAndSchemeInformation.LoTESequenceNumber}`,
        );
    return {
        service,
        store,
        versions,
        manager,
        trustListRepo,
        certService,
        generateJwt,
    };
}

describe("TrustListService", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("renewDueTrustLists", () => {
        it("re-issues lists in the renewal window with the next sequence number", async () => {
            const { service, store, versions } = createService([
                storedList("due", inDays(5)),
                storedList("fresh", inDays(20)),
            ]);

            await expect(service.renewDueTrustLists(now)).resolves.toBe(1);

            expect(store.get("due")).toMatchObject({
                sequenceNumber: 3,
                jwt: "due-jwt-3",
                data: {
                    LoTE: {
                        ListAndSchemeInformation: {
                            LoTESequenceNumber: 3,
                            ListIssueDateTime: publishedInDays(0),
                            NextUpdate: publishedInDays(30),
                        },
                        TrustedEntitiesList: entities,
                    },
                },
            });
            // The replaced list is kept as the previous version.
            expect(versions).toEqual([
                {
                    trustListId: "due",
                    tenantId: "tenant",
                    sequenceNumber: 2,
                    data: storedList("due", inDays(5)).data,
                    entityConfig: [],
                    jwt: "due-jwt-2",
                },
            ]);
            expect(store.get("fresh")).toEqual(storedList("fresh", inDays(20)));
        });

        it("renews expired lists and lists stored without the LoTE wrapper", async () => {
            const legacy = storedList("legacy", "2026-02-01T09:40:29.793Z");
            legacy.data = (legacy.data as LoTEDocument).LoTE;
            const { service, store } = createService([
                storedList("expired", "2026-02-01T09:40:29.793Z"),
                legacy,
            ]);

            await expect(service.renewDueTrustLists(now)).resolves.toBe(2);

            for (const id of ["expired", "legacy"]) {
                const data = store.get(id)!.data as LoTEDocument;
                expect(data.LoTE.ListAndSchemeInformation.NextUpdate).toBe(
                    publishedInDays(30),
                );
                expect(data.LoTE.TrustedEntitiesList).toEqual(entities);
            }
        });

        it("renews a list once when replicas run concurrently", async () => {
            const rows = [storedList("due", inDays(1))];
            const first = createService(rows);
            const second = createService(rows, first.store, first.versions);

            const renewed = await Promise.all([
                first.service.renewDueTrustLists(now),
                second.service.renewDueTrustLists(now),
            ]);

            expect(renewed.toSorted()).toEqual([0, 1]);
            expect(first.store.get("due")!.sequenceNumber).toBe(3);
            expect(first.versions).toHaveLength(1);
        });

        it("continues with other lists when one cannot be signed", async () => {
            const { service, store, generateJwt } = createService([
                storedList("broken", inDays(1)),
                storedList("due", inDays(1)),
            ]);
            generateJwt.mockRejectedValueOnce(new Error("KMS unavailable"));

            await expect(service.renewDueTrustLists(now)).resolves.toBe(1);
            expect(store.get("broken")!.sequenceNumber).toBe(2);
            expect(store.get("due")!.sequenceNumber).toBe(3);
        });
    });

    describe("create and update", () => {
        let externalEntity: TrustListCreateDto["entities"][number];

        beforeAll(async () => {
            x509.cryptoProvider.set(globalThis.crypto);
            const keys = await globalThis.crypto.subtle.generateKey(
                { name: "ECDSA", namedCurve: "P-256" },
                true,
                ["sign", "verify"],
            );
            const pem = (
                await x509.X509CertificateGenerator.createSelfSigned({
                    name: "CN=Issuer",
                    keys,
                    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
                })
            ).toString("pem");
            externalEntity = {
                type: "external",
                issuerCertPem: pem,
                revocationCertPem: pem,
                info: { name: "Issuer" },
            };
        });

        it("issues new lists with a fresh NextUpdate, ignoring stale imported data", async () => {
            const { service, trustListRepo } = createService([]);

            await service.create(
                {
                    id: "imported",
                    entities: [externalEntity],
                    data: {
                        ListAndSchemeInformation: {
                            NextUpdate: "2026-02-01T09:40:29.793Z",
                        },
                    },
                },
                { id: "tenant", name: "Tenant" },
            );

            const saved = trustListRepo.save.mock.calls[0][0] as TrustList;
            const nextUpdate = Date.parse(
                (saved.data as LoTEDocument).LoTE.ListAndSchemeInformation
                    .NextUpdate,
            );
            expect(nextUpdate - Date.now()).toBeGreaterThan(29 * DAY_MS);
            expect(saved.sequenceNumber).toBe(1);
        });

        describe("entity languages (ETSI TS 119 602 clause 6.1.4)", () => {
            const publishedEntity = async (
                info: Record<string, string>,
                providerType?: "wallet-provider",
            ): Promise<Record<string, any>> => {
                const { service, trustListRepo } = createService([]);
                await service.create(
                    {
                        id: "languages",
                        entities: [
                            {
                                ...externalEntity,
                                info,
                                ...(providerType ? { providerType } : {}),
                            } as TrustListCreateDto["entities"][number],
                        ],
                    },
                    { id: "tenant", name: "Tenant" },
                );
                const saved = trustListRepo.save.mock.calls[0][0] as TrustList;
                return (saved.data as LoTEDocument).LoTE
                    .TrustedEntitiesList[0] as Record<string, any>;
            };
            const langs = (entries: Array<{ lang: string }>) =>
                entries.map((entry) => entry.lang);

            it("publishes a non-English entity in its language and again in en", async () => {
                const entity = await publishedEntity({
                    name: "Musteraussteller",
                    lang: "de-at",
                    uri: "https://example.com/about",
                    contactUri: "mailto:info@example.com",
                    country: "AT",
                    locality: "Wien",
                    postalCode: "1010",
                    streetAddress: "Ring 1",
                });
                const info = entity.TrustedEntityInformation;

                expect(info.TEName).toEqual([
                    { lang: "de-at", value: "Musteraussteller" },
                    { lang: "en", value: "Musteraussteller" },
                ]);
                expect(info.TEInformationURI).toEqual([
                    { lang: "de-at", uriValue: "https://example.com/about" },
                    { lang: "en", uriValue: "https://example.com/about" },
                ]);
                expect(info.TEAddress.TEElectronicAddress).toEqual([
                    { lang: "de-at", uriValue: "mailto:info@example.com" },
                    { lang: "en", uriValue: "mailto:info@example.com" },
                ]);
                const address = {
                    Country: "AT",
                    Locality: "Wien",
                    PostalCode: "1010",
                    StreetAddress: "Ring 1",
                };
                expect(info.TEAddress.TEPostalAddress).toEqual([
                    { ...address, lang: "de-at" },
                    { ...address, lang: "en" },
                ]);
            });

            it.each([
                [undefined, "EAA-Issuance-Service", "EAA-Revocation-Service"],
                [
                    "wallet-provider" as const,
                    "Wallet-Issuance-Service",
                    "Wallet-Revocation-Service",
                ],
            ])(
                "publishes the service names of a %s entity in English only",
                async (providerType, issuance, revocation) => {
                    const entity = await publishedEntity(
                        { name: "Musteraussteller", lang: "de" },
                        providerType,
                    );

                    expect(
                        entity.TrustedEntityServices.map(
                            (svc: Record<string, any>) =>
                                svc.ServiceInformation.ServiceName,
                        ),
                    ).toEqual([
                        [{ lang: "en", value: issuance }],
                        [{ lang: "en", value: revocation }],
                    ]);
                },
            );

            it.each([undefined, "en"])(
                "publishes one en entry when lang is %s",
                async (lang) => {
                    const entity = await publishedEntity({
                        name: "Issuer",
                        uri: "https://example.com/about",
                        contactUri: "mailto:info@example.com",
                        ...(lang ? { lang } : {}),
                    });
                    const info = entity.TrustedEntityInformation;

                    expect(langs(info.TEName)).toEqual(["en"]);
                    expect(langs(info.TEInformationURI)).toEqual(["en"]);
                    expect(langs(info.TEAddress.TEPostalAddress)).toEqual([
                        "en",
                    ]);
                    expect(langs(info.TEAddress.TEElectronicAddress)).toEqual([
                        "en",
                    ]);
                },
            );
        });

        it("accepts external certificates as Base64 DER", async () => {
            const { service, trustListRepo } = createService([]);
            const pem = (externalEntity as { issuerCertPem: string })
                .issuerCertPem;
            const der = pem
                .replaceAll(/-----(BEGIN|END) CERTIFICATE-----/g, "")
                .replaceAll(/\s/g, "");

            await service.create(
                {
                    id: "der",
                    entities: [
                        {
                            ...externalEntity,
                            issuerCertPem: der,
                            revocationCertPem: der,
                        } as TrustListCreateDto["entities"][number],
                    ],
                },
                { id: "tenant", name: "Tenant" },
            );

            const saved = trustListRepo.save.mock.calls[0][0] as TrustList;
            expect(JSON.stringify(saved.data)).toContain(der);
        });

        it("publishes the parsed certificate, not stray characters around it", async () => {
            const { service, trustListRepo } = createService([]);
            const pem = (externalEntity as { issuerCertPem: string })
                .issuerCertPem;
            const der = pem
                .replaceAll(/-----(BEGIN|END) CERTIFICATE-----/g, "")
                .replaceAll(/\s/g, "");
            const spaced = `${der.slice(0, 10)} \t${der.slice(10)}`;

            await service.create(
                {
                    id: "spaced",
                    entities: [
                        {
                            ...externalEntity,
                            issuerCertPem: spaced,
                            revocationCertPem: spaced,
                        } as TrustListCreateDto["entities"][number],
                    ],
                },
                { id: "tenant", name: "Tenant" },
            );

            const published = JSON.stringify(
                (trustListRepo.save.mock.calls[0][0] as TrustList).data,
            );
            expect(published).toContain(der);
        });

        it("publishes each PEM certificate as the DER of its first certificate", async () => {
            const { service, trustListRepo } = createService([]);
            const issuer = externalEntity as {
                issuerCertPem: string;
            };
            const keys = await globalThis.crypto.subtle.generateKey(
                { name: "ECDSA", namedCurve: "P-256" },
                true,
                ["sign", "verify"],
            );
            const other = await x509.X509CertificateGenerator.createSelfSigned({
                name: "CN=Revocation",
                keys,
                signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
            });
            const issuerDer = Buffer.from(
                new x509.X509Certificate(issuer.issuerCertPem).rawData,
            ).toString("base64");
            const otherDer = Buffer.from(other.rawData).toString("base64");

            await service.create(
                {
                    id: "pem",
                    entities: [
                        {
                            ...externalEntity,
                            // A chain in one field publishes its first certificate only.
                            issuerCertPem: `${issuer.issuerCertPem}\n${other.toString("pem")}`,
                            revocationCertPem: other.toString("pem"),
                        } as TrustListCreateDto["entities"][number],
                    ],
                },
                { id: "tenant", name: "Tenant" },
            );

            const services = (
                (trustListRepo.save.mock.calls[0][0] as TrustList)
                    .data as LoTEDocument
            ).LoTE.TrustedEntitiesList![0].TrustedEntityServices.map(
                (service) =>
                    JSON.stringify(
                        service.ServiceInformation.ServiceDigitalIdentity,
                    ),
            );
            expect(services[0]).toContain(issuerDer);
            expect(services[0]).not.toContain(otherDer);
            expect(services[1]).toContain(otherDer);
        });

        it("refuses external certificates that are neither PEM nor Base64 DER at their fields", async () => {
            const { service, certService, trustListRepo } = createService([]);

            const error = await service
                .create(
                    {
                        id: "bad",
                        entities: [
                            externalEntity,
                            {
                                ...externalEntity,
                                issuerCertPem: "bm90IGEgY2VydGlmaWNhdGU=",
                                revocationCertPem: "  ",
                            } as TrustListCreateDto["entities"][number],
                        ],
                    },
                    { id: "tenant", name: "Tenant" },
                )
                .catch((caught: unknown) => caught);

            expect(error).toBeInstanceOf(TrustListInputError);
            expect((error as TrustListInputError).issues).toEqual([
                {
                    path: ["entities", 1, "issuerCertPem"],
                    code: "invalid_certificate",
                    message:
                        "issuerCertPem must be an X.509 certificate in PEM or Base64 DER.",
                },
                {
                    path: ["entities", 1, "revocationCertPem"],
                    code: "invalid_certificate",
                    message:
                        "revocationCertPem must be an X.509 certificate in PEM or Base64 DER.",
                },
            ]);
            expect(certService.find).not.toHaveBeenCalled();
            expect(trustListRepo.save).not.toHaveBeenCalled();
        });

        it("refuses other entity info the LoTE builder rejects at the entity's info, before it picks a trust list key chain", async () => {
            const { service, certService, trustListRepo } = createService([]);
            certService.find.mockRejectedValue(
                new NotFoundException("No trust list key chain"),
            );

            const error = await service
                .create(
                    {
                        id: "bad-lang",
                        entities: [
                            {
                                ...externalEntity,
                                // The body schema refuses this; the service
                                // still answers the builder's refusal.
                                info: { name: "Issuer", country: "Germany" },
                            },
                        ],
                    },
                    { id: "tenant", name: "Tenant" },
                )
                .catch((caught: unknown) => caught);

            expect(error).toBeInstanceOf(TrustListInputError);
            expect((error as TrustListInputError).issues).toEqual([
                expect.objectContaining({
                    path: ["entities", 0, "info"],
                    code: "invalid_entity_info",
                    message: expect.stringContaining("Country"),
                }),
            ]);
            expect(certService.find).not.toHaveBeenCalled();
            expect(trustListRepo.save).not.toHaveBeenCalled();
        });

        it("passes on other failures to pick a trust list key chain", async () => {
            const { service, certService } = createService([]);
            certService.find.mockRejectedValue(new Error("db"));

            const error = await service
                .create(
                    { id: "new", entities: [externalEntity] },
                    { id: "tenant", name: "Tenant" },
                )
                .catch((caught: unknown) => caught);

            expect(error).not.toBeInstanceOf(ConflictException);
            expect((error as Error).message).toBe("db");
        });

        it("answers 409 when no key chain is named and the tenant has no trust list key chain", async () => {
            const { service, certService } = createService([]);
            certService.find.mockRejectedValue(
                new NotFoundException(
                    "No key chain found with usage type 'trustList' for tenant tenant",
                ),
            );

            const error = await service
                .create(
                    { id: "no-signer", entities: [externalEntity] },
                    { id: "tenant", name: "Tenant" },
                )
                .catch((caught: unknown) => caught);

            expect(error).toBeInstanceOf(ConflictException);
            expect((error as Error).message).toContain(
                'Create a key chain with usage type "trustList" or name one in keyChainId.',
            );
        });

        it("publishes updates with compare-and-set and keeps the previous version", async () => {
            const { service, store, versions, manager } = createService([
                storedList("list", inDays(20)),
            ]);

            const updated = await service.update("tenant", "list", {
                description: "updated",
                entities: [externalEntity],
            });

            expect(manager.update).toHaveBeenCalledWith(
                expect.anything(),
                { tenantId: "tenant", id: "list", sequenceNumber: 2 },
                expect.objectContaining({ sequenceNumber: 3 }),
            );
            expect(updated).toMatchObject({
                description: "updated",
                sequenceNumber: 3,
                jwt: "list-jwt-3",
            });
            expect(store.get("list")!.entityConfig).toEqual([externalEntity]);
            expect(versions).toEqual([
                expect.objectContaining({
                    sequenceNumber: 2,
                    jwt: "list-jwt-2",
                }),
            ]);
        });

        it("rejects an update when the list changed concurrently", async () => {
            const { service, store, versions, trustListRepo } = createService([
                storedList("list", inDays(1)),
            ]);
            // A renewal publishes sequence number 3 after the update read the list.
            const read = trustListRepo.findOneBy.getMockImplementation()!;
            trustListRepo.findOneBy.mockImplementationOnce(async (q) => {
                const row = await read(q);
                await service.renewDueTrustLists(now);
                return row;
            });

            await expect(
                service.update("tenant", "list", {
                    entities: [externalEntity],
                }),
            ).rejects.toBeInstanceOf(ConflictException);
            expect(store.get("list")!.jwt).toBe("list-jwt-3");
            expect(versions).toHaveLength(1);
        });

        describe("signing key chain", () => {
            it("signs a new list without keyChainId with a trustList key chain of the tenant", async () => {
                const { service, certService, trustListRepo } = createService(
                    [],
                );

                await service.create(
                    { id: "new", entities: [externalEntity] },
                    { id: "tenant", name: "Tenant" },
                );

                expect(certService.find).toHaveBeenCalledWith({
                    tenantId: "tenant",
                    type: KeyUsageType.TrustList,
                });
                expect(certService.getCertificateById).not.toHaveBeenCalled();
                expect(
                    (trustListRepo.save.mock.calls[0][0] as TrustList)
                        .keyChainId,
                ).toBe("tenant-trust-list-key");
            });

            it("keeps the stored key chain on an update without keyChainId", async () => {
                const { service, certService, store } = createService([
                    storedList("list", inDays(20), {
                        keyChainId: "stored-key",
                    }),
                ]);
                certService.getCertificateById.mockResolvedValue(
                    trustListKey("stored-key"),
                );

                await service.update("tenant", "list", {
                    entities: [externalEntity],
                });

                expect(certService.getCertificateById).toHaveBeenCalledWith(
                    "tenant",
                    "stored-key",
                );
                expect(certService.find).not.toHaveBeenCalled();
                expect(store.get("list")!.keyChainId).toBe("stored-key");
            });

            it("refuses an update that names a key chain without trustList usage at keyChainId", async () => {
                const { service, certService, store, manager } = createService([
                    storedList("list", inDays(20), {
                        keyChainId: "stored-key",
                    }),
                ]);
                certService.getCertificatesByIds.mockResolvedValue(
                    new Map([
                        [
                            "other-key",
                            {
                                id: "other-key",
                                keyChain: {
                                    usageType: KeyUsageType.Attestation,
                                },
                            },
                        ],
                    ]),
                );

                const error = await service
                    .update("tenant", "list", {
                        entities: [externalEntity],
                        keyChainId: "other-key",
                    })
                    .catch((caught: unknown) => caught);

                expect((error as TrustListInputError).issues).toEqual([
                    {
                        path: ["keyChainId"],
                        code: "key_chain_usage_mismatch",
                        message:
                            "Key chain other-key is not valid for Trust List usage (key lacks TrustList usage)",
                    },
                ]);
                expect(manager.update).not.toHaveBeenCalled();
                expect(store.get("list")!.sequenceNumber).toBe(2);
            });

            it("answers 409 for an update that keeps a key chain that no longer exists", async () => {
                const { service, certService, manager } = createService([
                    storedList("list", inDays(20), {
                        keyChainId: "stored-key",
                    }),
                ]);
                certService.getCertificateById.mockRejectedValue(
                    new NotFoundException("Key chain stored-key not found"),
                );

                const error = await service
                    .update("tenant", "list", { entities: [externalEntity] })
                    .catch((caught: unknown) => caught);

                expect(error).toBeInstanceOf(ConflictException);
                expect((error as Error).message).toMatch(
                    /^Key chain stored-key not found\. /,
                );
                expect(manager.update).not.toHaveBeenCalled();
            });

            it("answers 409 when the certificate of the tenant's trust list key chain fails validation", async () => {
                const { service, certService } = createService([]);
                certService.find.mockRejectedValue(
                    new NotFoundException(
                        "Certificate validation failed: Certificate expired",
                    ),
                );

                const error = await service
                    .create(
                        { id: "new", entities: [externalEntity] },
                        { id: "tenant", name: "Tenant" },
                    )
                    .catch((caught: unknown) => caught);

                expect(error).toBeInstanceOf(ConflictException);
                expect((error as Error).message).toContain(
                    "Certificate validation failed",
                );
            });

            it("answers 409 for an update that keeps a key chain without trustList usage", async () => {
                const { service, certService, store, manager } = createService([
                    storedList("list", inDays(20), {
                        keyChainId: "stored-key",
                    }),
                ]);
                // For example after a key chain import reused its ID.
                certService.getCertificateById.mockImplementation(
                    async (_tenantId: string, id: string) => ({
                        id,
                        keyChain: { usageType: KeyUsageType.Attestation },
                    }),
                );

                await expect(
                    service.update("tenant", "list", {
                        entities: [externalEntity],
                    }),
                ).rejects.toThrow(
                    new ConflictException(
                        "Key chain stored-key of this trust list is not valid for Trust List usage (key lacks TrustList usage). Name a key chain with usage type trustList in keyChainId.",
                    ),
                );
                expect(manager.update).not.toHaveBeenCalled();
                expect(store.get("list")!.sequenceNumber).toBe(2);
            });
        });
    });

    describe("internal entity key chains", () => {
        it("refuses a key chain of another usage type before it picks a trust list key chain", async () => {
            const { service, certService, trustListRepo } = createService([]);
            certService.getCertificatesByIds.mockResolvedValue(
                new Map([
                    [
                        "status-key",
                        {
                            id: "status-key",
                            crt: [],
                            keyChain: { usageType: "statusList" },
                        },
                    ],
                ]),
            );

            const error = await service
                .create(
                    {
                        id: "new",
                        entities: [
                            {
                                type: "internal",
                                issuerKeyChainId: "status-key",
                                revocationKeyChainId: "status-key",
                                info: { name: "Issuer" },
                            },
                        ],
                    },
                    { id: "tenant", name: "Tenant" },
                )
                .catch((caught: unknown) => caught);

            expect(error).toBeInstanceOf(TrustListInputError);
            // The revocation field accepts the status list key chain.
            expect((error as TrustListInputError).issues).toEqual([
                {
                    path: ["entities", 0, "issuerKeyChainId"],
                    code: "key_chain_usage_mismatch",
                    message: expect.stringContaining('"statusList"'),
                },
            ]);
            // The key chains are read in one go; a refused list creates no
            // trust list key chain and is not saved.
            expect(certService.getCertificatesByIds).toHaveBeenCalledTimes(1);
            expect(certService.find).not.toHaveBeenCalled();
            expect(trustListRepo.save).not.toHaveBeenCalled();
        });

        it("refuses a missing key chain at each field before it picks a trust list key chain", async () => {
            const { service, certService } = createService([]);

            const error = await service
                .create(
                    {
                        id: "new",
                        entities: [
                            {
                                type: "internal",
                                issuerKeyChainId: "missing",
                                revocationKeyChainId: "missing",
                                info: { name: "Issuer" },
                            },
                        ],
                    },
                    { id: "tenant", name: "Tenant" },
                )
                .catch((caught: unknown) => caught);

            expect((error as TrustListInputError).issues).toEqual(
                ["issuerKeyChainId", "revocationKeyChainId"].map((field) => ({
                    path: ["entities", 0, field],
                    code: "key_chain_not_found",
                    message: 'Key chain "missing" does not exist.',
                })),
            );
            expect(certService.getCertificatesByIds).toHaveBeenCalledWith(
                "tenant",
                ["missing", "missing"],
            );
            expect(certService.find).not.toHaveBeenCalled();
        });

        it("passes on other failures to read a key chain", async () => {
            const { service, certService } = createService([]);
            certService.getCertificatesByIds.mockRejectedValue(
                new Error("database unavailable"),
            );

            await expect(
                service.create(
                    {
                        id: "new",
                        entities: [
                            {
                                type: "internal",
                                issuerKeyChainId: "key",
                                revocationKeyChainId: "key",
                                info: { name: "Issuer" },
                            },
                        ],
                    },
                    { id: "tenant", name: "Tenant" },
                ),
            ).rejects.toThrow("database unavailable");
        });
    });

    describe("signing key chain", () => {
        it.each([
            [
                "a key chain that does not exist",
                new Map<string, object>(),
                "key_chain_not_found",
                'Key chain "signer" does not exist.',
            ],
            [
                "a key chain of another usage type",
                new Map<string, object>([
                    [
                        "signer",
                        {
                            id: "signer",
                            crt: [],
                            keyChain: { usageType: "attestation" },
                        },
                    ],
                ]),
                "key_chain_usage_mismatch",
                "Key chain signer is not valid for Trust List usage (key lacks TrustList usage)",
            ],
        ])(
            "refuses %s at keyChainId, before the entities' issues",
            async (_, found, code, message) => {
                const { service, certService } = createService([]);
                certService.getCertificatesByIds.mockResolvedValue(found);

                const error = await service
                    .create(
                        {
                            id: "new",
                            keyChainId: "signer",
                            entities: [
                                {
                                    type: "external",
                                    issuerCertPem: "not a certificate",
                                    revocationCertPem: "not a certificate",
                                    info: { name: "Issuer" },
                                },
                            ],
                        },
                        { id: "tenant", name: "Tenant" },
                    )
                    .catch((caught: unknown) => caught);

                expect((error as TrustListInputError).issues).toEqual([
                    { path: ["keyChainId"], code, message },
                    expect.objectContaining({
                        path: ["entities", 0, "issuerCertPem"],
                    }),
                    expect.objectContaining({
                        path: ["entities", 0, "revocationCertPem"],
                    }),
                ]);
                expect(certService.find).not.toHaveBeenCalled();
            },
        );
    });

    describe("versions", () => {
        const version = (
            id: string,
            trustListId: string,
            tenantId = "tenant",
        ) => ({
            id,
            trustListId,
            tenantId,
            sequenceNumber: 1,
        });
        const versions = [
            version("v1", "list"),
            version("v2", "list", "other"),
            version("v3", "other-list"),
        ];

        it("lists only the versions of that list of the tenant", async () => {
            const { service } = createService(
                [storedList("list", inDays(20))],
                undefined,
                versions,
            );

            await expect(
                service.getVersionHistory("tenant", "list"),
            ).resolves.toEqual([versions[0]]);
        });

        it("reads a version of that list of the tenant only", async () => {
            const { service } = createService([], undefined, versions);

            await expect(
                service.getVersion("tenant", "list", "v1"),
            ).resolves.toEqual(versions[0]);
            for (const [trustListId, versionId] of [
                ["other-list", "v1"],
                ["list", "v2"],
            ]) {
                await expect(
                    service.getVersion("tenant", trustListId, versionId),
                ).rejects.toThrow("Trust list version not found");
            }
        });

        it("answers 404 for a list of another tenant", async () => {
            const { service } = createService([
                storedList("list", inDays(20), { tenantId: "other" }),
            ]);

            await expect(
                service.getVersionHistory("tenant", "list"),
            ).rejects.toBeInstanceOf(NotFoundException);
        });
    });

    describe("exportTrustList", () => {
        it("leaves out an unset description so the create endpoint accepts the export", async () => {
            // A nullable column is read back as null, not undefined.
            const { service } = createService([
                storedList("list", inDays(20), {
                    description: null,
                    entityConfig: [
                        {
                            type: "internal",
                            issuerKeyChainId: "issuer-key",
                            revocationKeyChainId: "status-key",
                            info: { name: "Issuer" },
                        },
                    ],
                } as unknown as Partial<TrustList>),
            ]);

            const exported = JSON.parse(
                JSON.stringify(await service.exportTrustList("tenant", "list")),
            );

            expect(exported).not.toHaveProperty("description");
            expect(TrustListCreateSchema.safeParse(exported).success).toBe(
                true,
            );
        });

        it("exports a description that is set", async () => {
            const { service } = createService([
                storedList("list", inDays(20), { description: "Issuers" }),
            ]);

            const exported = await service.exportTrustList("tenant", "list");

            expect(exported.description).toBe("Issuers");
        });
    });

    describe("removeUnreferenced", () => {
        function referencesFound(found: TrustListReference[]) {
            const references = new TrustListReferences();
            const findReferences = vi.fn(
                async (_list: ManagedTrustList) => found,
            );
            references.register({
                kind: "PresentationConfig",
                findReferences,
                namesList: () => false,
            });
            return { references, findReferences };
        }

        it("deletes a list that no configuration references", async () => {
            const { references, findReferences } = referencesFound([]);
            const { service, store } = createService(
                [storedList("list", inDays(20))],
                undefined,
                undefined,
                references,
            );

            await service.removeUnreferenced("tenant", "list");

            expect(findReferences).toHaveBeenCalledWith({
                tenantId: "tenant",
                id: "list",
            });
            expect(store.has("list")).toBe(false);
        });

        it("keeps a referenced list and names the references", async () => {
            const found: TrustListReference[] = [
                { kind: "PresentationConfig", id: "pid", description: "PID" },
                { kind: "IssuanceConfig" },
            ];
            const { references } = referencesFound(found);
            const { service, store, trustListRepo } = createService(
                [storedList("list", inDays(20))],
                undefined,
                undefined,
                references,
            );

            const error = await service
                .removeUnreferenced("tenant", "list")
                .catch((e: unknown) => e);

            expect(error).toBeInstanceOf(TrustListInUseError);
            expect((error as TrustListInUseError).references).toEqual(found);
            expect(trustListRepo.delete).not.toHaveBeenCalled();
            expect(store.has("list")).toBe(true);
        });

        it("keeps the list when a reference source fails", async () => {
            const references = new TrustListReferences();
            references.register({
                kind: "PresentationConfig",
                findReferences: async () => {
                    throw new Error("database unavailable");
                },
                namesList: () => false,
            });
            const { service, store, trustListRepo } = createService(
                [storedList("list", inDays(20))],
                undefined,
                undefined,
                references,
            );

            await expect(
                service.removeUnreferenced("tenant", "list"),
            ).rejects.toThrow("database unavailable");
            expect(trustListRepo.delete).not.toHaveBeenCalled();
            expect(store.has("list")).toBe(true);
        });

        it("does nothing for a list of another tenant or an unknown ID", async () => {
            const { references, findReferences } = referencesFound([]);
            const { service, store, trustListRepo } = createService(
                [storedList("list", inDays(20))],
                undefined,
                undefined,
                references,
            );

            await service.removeUnreferenced("other-tenant", "list");
            await service.removeUnreferenced("tenant", "unknown");

            expect(findReferences).not.toHaveBeenCalled();
            expect(trustListRepo.delete).not.toHaveBeenCalled();
            expect(store.has("list")).toBe(true);
        });
    });
});
