import { ConflictException } from "@nestjs/common";
import type { LoTEDocument } from "@owf/eudi-lote";
import * as x509 from "@peculiar/x509";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TrustListCreateDto } from "./dto/trust-list-create.dto.js";
import type { TrustList } from "./entities/trust-list.entity.js";
import { TrustListService } from "./trustlist.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-02T12:00:00.000Z");
const inDays = (days: number) =>
    new Date(now.getTime() + days * DAY_MS).toISOString();

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

/**
 * Service on an in-memory store whose `update` honours its WHERE criteria
 * like the database does, so compare-and-set behaviour is observable.
 */
function createService(
    rows: TrustList[],
    store = new Map(rows.map((row) => [row.id, structuredClone(row)])),
    versions: object[] = [],
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
        getCertificateById: vi.fn().mockResolvedValue({ id: "trust-list-key" }),
        findOrCreate: vi.fn().mockResolvedValue({ id: "trust-list-key" }),
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
                            ListIssueDateTime: now.toISOString(),
                            NextUpdate: inDays(30),
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
                    inDays(30),
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
    });
});
