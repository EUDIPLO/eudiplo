import { BadRequestException, ConflictException } from "@nestjs/common";
import type { LoTEDocument } from "@owf/eudi-lote";
import * as x509 from "@peculiar/x509";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeyUsageType } from "../../crypto/key/types/key-usage-type.js";
import { TrustListReferences } from "./application/trust-list-references.js";
import { TrustListEntityKeyChainUsageError } from "./domain/trust-list-entity-key-chains.js";
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
        // The tenant's pick, distinct from any key chain named by ID.
        find: vi.fn().mockResolvedValue(trustListKey("tenant-trust-list-key")),
    };
    const service = new TrustListService(
        trustListRepo as any,
        {} as any,
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
                info: {
                    name: "Issuer",
                    contactUri: "info@example.com",
                    website: "https://example.com/",
                },
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

        it("publishes the e-mail address, web site and telephone number as TEElectronicAddress", async () => {
            const { service, trustListRepo } = createService([]);

            await service.create(
                {
                    id: "address",
                    entities: [
                        {
                            ...externalEntity,
                            info: {
                                ...externalEntity.info,
                                lang: "de-at",
                                phone: "+49-30-1234567",
                            },
                        },
                        {
                            ...externalEntity,
                            info: {
                                ...externalEntity.info,
                                contactUri: "mailto:info@example.com",
                                phone: "tel:+49-30-1234567",
                            },
                        },
                    ],
                },
                { id: "tenant", name: "Tenant" },
            );

            const saved = trustListRepo.save.mock.calls[0][0] as TrustList;
            const addresses = (
                saved.data as LoTEDocument
            ).LoTE.TrustedEntitiesList?.map(
                (entity) =>
                    entity.TrustedEntityInformation.TEAddress
                        ?.TEElectronicAddress,
            );
            expect(addresses).toEqual([
                [
                    { lang: "de-at", uriValue: "mailto:info@example.com" },
                    { lang: "de-at", uriValue: "https://example.com/" },
                    { lang: "de-at", uriValue: "tel:+49-30-1234567" },
                ],
                [
                    { lang: "en", uriValue: "mailto:info@example.com" },
                    { lang: "en", uriValue: "https://example.com/" },
                    { lang: "en", uriValue: "tel:+49-30-1234567" },
                ],
            ]);
        });

        it("publishes no telephone entry when phone is unset", async () => {
            const { service, trustListRepo } = createService([]);

            await service.create(
                { id: "no-phone", entities: [externalEntity] },
                { id: "tenant", name: "Tenant" },
            );

            const saved = trustListRepo.save.mock.calls[0][0] as TrustList;
            expect(
                (saved.data as LoTEDocument).LoTE.TrustedEntitiesList?.[0]
                    .TrustedEntityInformation.TEAddress?.TEElectronicAddress,
            ).toEqual([
                { lang: "en", uriValue: "mailto:info@example.com" },
                { lang: "en", uriValue: "https://example.com/" },
            ]);
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

        it("rejects an invalid revocation certificate by its field name", async () => {
            const { service } = createService([]);

            await expect(
                service.create(
                    {
                        id: "bad-revocation",
                        entities: [
                            {
                                ...externalEntity,
                                revocationCertPem: "bm90IGEgY2VydGlmaWNhdGU=",
                            } as TrustListCreateDto["entities"][number],
                        ],
                    },
                    { id: "tenant", name: "Tenant" },
                ),
            ).rejects.toThrow(
                "revocationCertPem is not a valid X.509 certificate",
            );
        });

        it("rejects an external certificate that is neither PEM nor Base64 DER, before any key chain error", async () => {
            const { service, certService } = createService([]);
            certService.find.mockRejectedValue(
                new Error("No key chain found with usage type 'trustList'"),
            );

            await expect(
                service.create(
                    {
                        id: "bad",
                        entities: [
                            {
                                ...externalEntity,
                                issuerCertPem: "bm90IGEgY2VydGlmaWNhdGU=",
                            } as TrustListCreateDto["entities"][number],
                        ],
                    },
                    { id: "tenant", name: "Tenant" },
                ),
            ).rejects.toThrow("issuerCertPem is not a valid X.509 certificate");
            expect(certService.find).not.toHaveBeenCalled();
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
            const read = trustListRepo.findOneByOrFail.getMockImplementation()!;
            trustListRepo.findOneByOrFail.mockImplementationOnce(async (q) => {
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

            it.each([
                ["names", { keyChainId: "other-key" }],
                ["keeps", {}],
            ])(
                "refuses an update that %s a key chain without trustList usage",
                async (_, keyChain) => {
                    const { service, certService, store, manager } =
                        createService([
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
                            ...keyChain,
                        }),
                    ).rejects.toThrow(
                        new BadRequestException(
                            "keyChainId" in keyChain
                                ? "Key chain other-key is not valid for Trust List usage (key lacks TrustList usage)"
                                : "Key chain stored-key of this trust list is not valid for Trust List usage (key lacks TrustList usage). Name a key chain with usage type trustList in keyChainId.",
                        ),
                    );
                    expect(manager.update).not.toHaveBeenCalled();
                    expect(store.get("list")!.sequenceNumber).toBe(2);
                },
            );
        });
    });

    describe("internal entity key chains", () => {
        it("refuses a key chain of another usage type before it picks a trust list key chain", async () => {
            const { service, certService, trustListRepo } = createService([]);
            certService.getCertificateById.mockResolvedValue({
                id: "status-key",
                crt: [],
                keyChain: { usageType: "statusList" },
            });

            const error = await service
                .create(
                    {
                        id: "new",
                        entities: [
                            {
                                type: "internal",
                                issuerKeyChainId: "status-key",
                                revocationKeyChainId: "status-key",
                                info: {
                                    name: "Issuer",
                                    contactUri: "info@example.com",
                                    website: "https://example.com/",
                                },
                            },
                        ],
                    },
                    { id: "tenant", name: "Tenant" },
                )
                .catch((caught: unknown) => caught);

            expect(error).toBeInstanceOf(TrustListEntityKeyChainUsageError);
            // The revocation field accepts the status list key chain.
            expect((error as TrustListEntityKeyChainUsageError).issues).toEqual(
                [
                    {
                        index: 0,
                        field: "issuerKeyChainId",
                        message: expect.stringContaining('"statusList"'),
                    },
                ],
            );
            // Each key chain is read once; a refused list creates no
            // trust list key chain and is not saved.
            expect(certService.getCertificateById).toHaveBeenCalledTimes(1);
            expect(certService.find).not.toHaveBeenCalled();
            expect(trustListRepo.save).not.toHaveBeenCalled();
        });

        it("fails on a missing key chain before it picks a trust list key chain", async () => {
            const { service, certService } = createService([]);
            certService.getCertificateById.mockRejectedValue(
                new Error("Key chain not found"),
            );

            await expect(
                service.create(
                    {
                        id: "new",
                        entities: [
                            {
                                type: "internal",
                                issuerKeyChainId: "missing",
                                revocationKeyChainId: "missing",
                                info: {
                                    name: "Issuer",
                                    contactUri: "info@example.com",
                                    website: "https://example.com/",
                                },
                            },
                        ],
                    },
                    { id: "tenant", name: "Tenant" },
                ),
            ).rejects.toThrow("Key chain not found");
            expect(certService.find).not.toHaveBeenCalled();
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
                            info: {
                                name: "Issuer",
                                contactUri: "info@example.com",
                                website: "https://example.com/",
                            },
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
