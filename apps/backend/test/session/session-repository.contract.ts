import { randomUUID } from "node:crypto";
import type { CredentialOfferObject } from "@openid4vc/openid4vci";
import { DataSource } from "typeorm";
import { beforeEach, describe, expect, it } from "vitest";
import { ClientEntity } from "../../src/auth/client/entities/client.entity.js";
import { TenantEntity } from "../../src/auth/tenant/entities/tenant.entity.js";
import { DataEncryptionService } from "../../src/platform/data-encryption/data-encryption.service.js";
import { initializeEncryptionTransformer } from "../../src/platform/data-encryption/encrypted-column.transformer.js";
import { TypeOrmSessionRepository } from "../../src/session/adapters/typeorm-session.repository.js";
import { TypeOrmSessionRetentionPolicies } from "../../src/session/adapters/typeorm-session-retention-policies.js";
import { SessionCleanupMode } from "../../src/session/domain/session-retention.js";
import {
    SessionStatus,
    stateUpdate,
} from "../../src/session/domain/session-state.js";
import { Session } from "../../src/session/entities/session.entity.js";

export const sessionEntities = [Session, TenantEntity, ClientEntity];
const offer: CredentialOfferObject = {
    credential_issuer: "https://issuer.example/tenant-a",
    credential_configuration_ids: ["pid"],
};

export async function initializeTestEncryption() {
    const encryption = new DataEncryptionService({
        name: "contract-test",
        getKey: async () => Buffer.alloc(32, 7),
    });
    await encryption.initialize();
    initializeEncryptionTransformer(encryption);
}

/** The same observable contract runs against real SQLite and PostgreSQL adapters. */
export function sessionRepositoryContract(getDataSource: () => DataSource) {
    describe("session repository contract", () => {
        let adapter: TypeOrmSessionRepository;
        let sessionId: string;
        beforeEach(async () => {
            const db = getDataSource();
            await db.getRepository(Session).clear();
            await db
                .getRepository(TenantEntity)
                .save({ id: "tenant-a", sessionConfig: null });
            await db
                .getRepository(TenantEntity)
                .save({ id: "tenant-b", sessionConfig: null });
            sessionId = randomUUID();
            await db
                .getRepository(Session)
                .save({ id: sessionId, tenantId: "tenant-a", offer });
            adapter = new TypeOrmSessionRepository(db.getRepository(Session));
        });

        it("creates plain session data with persisted defaults and encrypted values", async () => {
            const id = randomUUID();
            const created = await adapter.create({
                id,
                tenantId: "tenant-a",
                offer,
                requestId: "presentation",
            });
            expect(created).not.toBeInstanceOf(Session);
            expect(created).toMatchObject({
                id,
                tenantId: "tenant-a",
                status: SessionStatus.Active,
                txCodeFailedAttempts: 0,
                consumed: false,
                notifications: [],
                offer,
            });
            expect(created.createdAt).toBeInstanceOf(Date);
            expect(created.updatedAt).toBeInstanceOf(Date);
            const loaded = await adapter.findForTenant("tenant-a", id);
            const entity = await getDataSource()
                .getRepository(Session)
                .findOneByOrFail({ id });
            expect(JSON.parse(JSON.stringify(loaded))).toEqual(
                JSON.parse(JSON.stringify(entity)),
            );
            expect(loaded).not.toBeInstanceOf(Session);
            expect(loaded?.tenant).not.toBeInstanceOf(TenantEntity);
            const raw = await getDataSource()
                .getRepository(Session)
                .createQueryBuilder("session")
                .select("session.offer", "offer")
                .where("session.id = :id", { id })
                .getRawOne();
            expect(raw.offer).not.toContain("credential_issuer");
        });

        it("preserves save semantics when creation targets an existing session", async () => {
            await adapter.create({
                id: sessionId,
                tenantId: "tenant-a",
                requestId: "updated",
            });
            expect(
                await adapter.findForTenant("tenant-a", sessionId),
            ).toMatchObject({ offer, requestId: "updated" });
        });

        it("updates only the tenant target, preserving omitted values and clearing explicit nulls", async () => {
            expect(
                await adapter.updateForTenant("tenant-b", sessionId, {
                    offer: null,
                }),
            ).toBe(0);
            expect(
                await adapter.updateForTenant("tenant-a", randomUUID(), {
                    offer: null,
                }),
            ).toBe(0);
            expect(
                await adapter.updateForTenant("tenant-a", sessionId, {
                    requestObject: "signed",
                    offer: undefined,
                }),
            ).toBe(1);
            expect(
                await adapter.findForTenant("tenant-a", sessionId),
            ).toMatchObject({ requestObject: "signed", offer });
            const changed = {
                ...offer,
                credential_configuration_ids: ["replacement"],
            };
            await adapter.updateForTenant("tenant-a", sessionId, {
                offer: changed,
                responseEncryptionPrivateJwk: { kty: "oct", k: "secret" },
            });
            expect(
                await adapter.findForTenant("tenant-a", sessionId),
            ).toMatchObject({
                offer: changed,
                responseEncryptionPrivateJwk: { kty: "oct", k: "secret" },
            });
            await adapter.updateForTenant("tenant-a", sessionId, {
                offer: null,
                responseEncryptionPrivateJwk: null,
            });
            expect(
                await adapter.findForTenant("tenant-a", sessionId),
            ).toMatchObject({
                offer: null,
                responseEncryptionPrivateJwk: null,
                requestObject: "signed",
            });
        });

        it("applies an unconsumed update once, only within the tenant scope", async () => {
            const completion = {
                status: SessionStatus.Completed,
                consumed: true,
                responseCode: "first",
            };
            await expect(
                adapter.updateUnconsumedForTenant(
                    "tenant-b",
                    sessionId,
                    completion,
                ),
            ).resolves.toBe(false);

            const results = await Promise.all(
                Array.from({ length: 8 }, (_, index) =>
                    adapter.updateUnconsumedForTenant("tenant-a", sessionId, {
                        ...completion,
                        responseCode: `response-${index}`,
                    }),
                ),
            );
            expect(results.filter(Boolean)).toHaveLength(1);
            const winner = results.indexOf(true);

            await expect(
                adapter.updateUnconsumedForTenant(
                    "tenant-a",
                    sessionId,
                    completion,
                ),
            ).resolves.toBe(false);
            const stored = await getDataSource()
                .getRepository(Session)
                .findOneByOrFail({ id: sessionId });
            expect(stored).toMatchObject({
                consumed: true,
                status: SessionStatus.Completed,
                responseCode: `response-${winner}`,
            });
        });

        it("keeps token and PAR lookups tenant scoped and matches only the requested identifier", async () => {
            await adapter.updateForTenant("tenant-a", sessionId, {
                authorization_code: "code",
                refresh_token: "refresh",
                request_uri: "uri",
            });
            for (const [method, value] of [
                ["findByAuthorizationCode", "code"],
                ["findByRefreshToken", "refresh"],
                ["findByRequestUri", "uri"],
                ["findForTenant", sessionId],
            ] as const) {
                expect(await adapter[method]("tenant-a", value)).toMatchObject({
                    id: sessionId,
                });
                expect(await adapter[method]("tenant-b", value)).toBeNull();
                expect(
                    await adapter[method]("tenant-a", randomUUID()),
                ).toBeNull();
            }
            expect(
                await adapter.findByIdForInternalFlow(sessionId),
            ).toMatchObject({ id: sessionId });
            expect(
                await adapter.findByIdForInternalFlow(randomUUID()),
            ).toBeNull();
        });

        it("preserves wallet nonce precedence, legacy ID fallback, and ISO protocol restriction", async () => {
            const nonceMatch = randomUUID();
            await adapter.create({
                id: nonceMatch,
                tenantId: "tenant-b",
                walletNonce: sessionId,
            });
            expect(await adapter.findForWalletRequest(sessionId)).toMatchObject(
                { id: nonceMatch },
            );
            await adapter.deleteForTenant("tenant-b", nonceMatch);
            expect(await adapter.findForWalletRequest(sessionId)).toMatchObject(
                { id: sessionId },
            );
            expect(await adapter.findForWalletRequest(randomUUID())).toBeNull();
            expect(await adapter.findIso18013Session(sessionId)).toBeNull();
            await adapter.updateForTenant("tenant-a", sessionId, {
                dcApiProtocol: "iso-18013-7",
            });
            expect(await adapter.findIso18013Session(sessionId)).toMatchObject({
                id: sessionId,
            });
        });

        it("binds only existing active sessions for the tenant and configured external server", async () => {
            await adapter.updateForTenant("tenant-a", sessionId, {
                authorizationServerId: "external",
                externalSubject: "old",
            });
            const binding = {
                tenantId: "tenant-a",
                sessionId,
                authorizationServerId: "external",
                externalIssuer: "https://external.example",
                externalSubject: "new",
            };
            expect(
                await adapter.bindExternalAuthorization({
                    ...binding,
                    tenantId: "tenant-b",
                }),
            ).toBeNull();
            expect(
                await adapter.bindExternalAuthorization({
                    ...binding,
                    authorizationServerId: "other",
                }),
            ).toBeNull();
            expect(
                await adapter.bindExternalAuthorization({
                    ...binding,
                    sessionId: randomUUID(),
                }),
            ).toBeNull();
            for (const status of [
                SessionStatus.Fetched,
                SessionStatus.Completed,
                SessionStatus.Failed,
                SessionStatus.Expired,
            ]) {
                await adapter.updateForTenant("tenant-a", sessionId, {
                    status,
                });
                expect(
                    await adapter.bindExternalAuthorization(binding),
                ).toBeNull();
            }
            await adapter.updateForTenant("tenant-a", sessionId, {
                status: SessionStatus.Active,
            });
            const before = await adapter.bindExternalAuthorization(binding);
            expect(before).toMatchObject({
                id: sessionId,
                externalSubject: "old",
            });
            expect(
                await adapter.findForTenant("tenant-a", sessionId),
            ).toMatchObject({
                externalIssuer: binding.externalIssuer,
                externalSubject: "new",
            });
            expect(await getDataSource().getRepository(Session).count()).toBe(
                1,
            );
        });

        it("increments failed transaction codes only within the tenant scope", async () => {
            expect(
                await adapter.incrementFailedTxCodeAttempts(
                    "tenant-b",
                    sessionId,
                ),
            ).toBeNull();
            expect(
                await adapter.incrementFailedTxCodeAttempts(
                    "tenant-a",
                    randomUUID(),
                ),
            ).toBeNull();
            const repository = getDataSource().getRepository(Session);
            expect(
                (await repository.findOneByOrFail({ id: sessionId }))
                    .txCodeFailedAttempts,
            ).toBe(0);
            expect(
                await adapter.incrementFailedTxCodeAttempts(
                    "tenant-a",
                    sessionId,
                ),
            ).toBe(1);
            expect(
                await adapter.incrementFailedTxCodeAttempts(
                    "tenant-a",
                    sessionId,
                ),
            ).toBe(2);
            const persisted = await repository.findOneByOrFail({
                id: sessionId,
            });
            expect(persisted.status).toBe(SessionStatus.Active);
            expect(persisted.offer).toEqual(offer);
            expect(persisted.consumed).toBe(false);
        });

        it("loses no increments for concurrent failed transaction codes", async () => {
            const counts = await Promise.all(
                Array.from({ length: 8 }, () =>
                    adapter.incrementFailedTxCodeAttempts(
                        "tenant-a",
                        sessionId,
                    ),
                ),
            );
            expect(
                counts.every(
                    (count) => count !== null && count >= 1 && count <= 8,
                ),
            ).toBe(true);
            expect(
                (
                    await getDataSource()
                        .getRepository(Session)
                        .findOneByOrFail({ id: sessionId })
                ).txCodeFailedAttempts,
            ).toBe(8);
        });

        it("lists only tenant summaries with filters, ordering and pagination", async () => {
            const repository = getDataSource().getRepository(Session);
            await repository.delete({ id: sessionId });
            const ids = [randomUUID(), randomUUID(), randomUUID()];
            await repository.save([
                {
                    id: ids[0],
                    tenantId: "tenant-a",
                    createdAt: new Date("2025-01-01"),
                    updatedAt: new Date("2025-01-03"),
                    offer,
                },
                {
                    id: ids[1],
                    tenantId: "tenant-a",
                    createdAt: new Date("2025-01-02"),
                    updatedAt: new Date("2025-01-02"),
                    requestId: "",
                    status: SessionStatus.Completed,
                },
                {
                    id: ids[2],
                    tenantId: "tenant-b",
                    createdAt: new Date("2025-01-03"),
                    updatedAt: new Date("2025-01-01"),
                },
            ]);
            const page = await adapter.listForTenant("tenant-a", {
                page: 1,
                pageSize: 1,
            });
            expect(page.total).toBe(2);
            expect(page.items).toEqual([
                {
                    id: ids[0],
                    status: SessionStatus.Active,
                    createdAt: new Date("2025-01-01"),
                    requestId: null,
                },
            ]);
            expect(page.items[0]).not.toBeInstanceOf(Session);
            expect(
                await adapter.listForTenant("tenant-a", {
                    page: 2,
                    pageSize: 1,
                }),
            ).toMatchObject({ total: 2, items: [{ id: ids[1] }] });
            expect(
                await adapter.listForTenant("tenant-a", {
                    page: 3,
                    pageSize: 1,
                }),
            ).toEqual({ total: 2, items: [] });
            expect(
                await adapter.listForTenant("tenant-a", {
                    page: 1,
                    pageSize: 10,
                    type: "issuance",
                }),
            ).toMatchObject({ total: 1, items: [{ id: ids[0] }] });
            expect(
                await adapter.listForTenant("tenant-a", {
                    page: 1,
                    pageSize: 10,
                    type: "presentation",
                    status: SessionStatus.Completed,
                }),
            ).toMatchObject({
                total: 1,
                items: [{ id: ids[1], requestId: "" }],
            });
            expect(
                await adapter.listForTenant("tenant-a", {
                    page: 1,
                    pageSize: 10,
                    type: "presentation",
                    status: SessionStatus.Active,
                }),
            ).toEqual({ total: 0, items: [] });
            expect(
                (
                    await adapter.listForTenant("tenant-a", {
                        page: 1,
                        pageSize: 10,
                        sortBy: "createdAt",
                        sortOrder: "desc",
                    })
                ).items.map((item) => item.id),
            ).toEqual([ids[1], ids[0]]);
            expect(
                (
                    await adapter.listForTenant("tenant-a", {
                        page: 1,
                        pageSize: 10,
                        sortBy: "createdAt",
                        sortOrder: "asc",
                    })
                ).items.map((item) => item.id),
            ).toEqual([ids[0], ids[1]]);
        });

        it("deletes only the requested tenant's session and tolerates repeated or missing deletes", async () => {
            const repository = getDataSource().getRepository(Session);
            await adapter.deleteForTenant("tenant-b", sessionId);
            expect(await repository.existsBy({ id: sessionId })).toBe(true);
            await adapter.deleteForTenant("tenant-a", sessionId);
            expect(await repository.existsBy({ id: sessionId })).toBe(false);
            await expect(
                adapter.deleteForTenant("tenant-a", sessionId),
            ).resolves.toBeUndefined();
        });

        it("finds only overdue active/fetched presentations across tenants, without returning entities or sensitive data", async () => {
            const repository = getDataSource().getRepository(Session);
            const past = new Date("2025-01-01");
            const future = new Date("2025-01-03");
            const active = randomUUID();
            const fetched = randomUUID();
            await repository.save([
                {
                    id: active,
                    tenantId: "tenant-a",
                    requestId: "a",
                    expiresAt: past,
                    status: SessionStatus.Active,
                    responseEncryptionPrivateJwk: {
                        kty: "oct",
                        k: "private-key",
                    },
                },
                {
                    id: fetched,
                    tenantId: "tenant-b",
                    requestId: "b",
                    expiresAt: past,
                    status: SessionStatus.Fetched,
                },
                {
                    id: randomUUID(),
                    tenantId: "tenant-a",
                    expiresAt: past,
                    status: SessionStatus.Active,
                },
                {
                    id: randomUUID(),
                    tenantId: "tenant-a",
                    requestId: "future",
                    expiresAt: future,
                    status: SessionStatus.Active,
                },
                {
                    id: randomUUID(),
                    tenantId: "tenant-a",
                    requestId: "no-expiry",
                    status: SessionStatus.Active,
                },
                ...[
                    SessionStatus.Completed,
                    SessionStatus.Failed,
                    SessionStatus.Expired,
                ].map((status) => ({
                    id: randomUUID(),
                    tenantId: "tenant-a",
                    requestId: "terminal",
                    expiresAt: past,
                    status,
                })),
            ]);
            const result = await adapter.findExpiredPresentationsForMaintenance(
                new Date("2025-01-02T12:00:00Z"),
            );
            expect(result).toHaveLength(2);
            expect(result).toEqual(
                expect.arrayContaining([
                    { id: active, tenantId: "tenant-a", requestId: "a" },
                    { id: fetched, tenantId: "tenant-b", requestId: "b" },
                ]),
            );
            expect(result[0]).not.toBeInstanceOf(Session);
        });

        it("deletes only the selected tenant's sessions strictly before the creation cutoff", async () => {
            const repository = getDataSource().getRepository(Session);
            const cutoff = new Date("2025-01-02T12:00:00Z");
            await repository.update(sessionId, {
                createdAt: new Date("2025-01-01T12:00:00Z"),
            });
            const boundaryId = randomUUID();
            const otherId = randomUUID();
            await repository.save([
                { id: boundaryId, tenantId: "tenant-a", createdAt: cutoff },
                {
                    id: otherId,
                    tenantId: "tenant-b",
                    createdAt: new Date("2025-01-01T12:00:00Z"),
                },
            ]);
            await expect(
                adapter.deleteSessionsCreatedBefore("tenant-a", cutoff),
            ).resolves.toBe(1);
            expect(await repository.findOneBy({ id: sessionId })).toBeNull();
            expect(
                await repository.findOneBy({ id: boundaryId }),
            ).not.toBeNull();
            expect(await repository.findOneBy({ id: otherId })).not.toBeNull();
            await expect(
                adapter.deleteSessionsCreatedBefore("tenant-a", cutoff),
            ).resolves.toBe(0);
        });

        it("anonymizes exactly the existing sensitive fields as SQL NULL, retaining metadata and making retries no-ops", async () => {
            const repository = getDataSource().getRepository(Session);
            const cutoff = new Date("2025-01-02T12:00:00Z");
            await repository.save({
                id: sessionId,
                tenantId: "tenant-a",
                createdAt: new Date("2025-01-01T12:00:00Z"),
                credentials: [],
                credentialPayload: { credentialConfigurationIds: ["pid"] },
                auth_queries: {},
                offer,
                requestObject: "signed-request",
                responseEncryptionPrivateJwk: { kty: "oct", k: "private-key" },
                status: SessionStatus.Completed,
                requestId: "presentation",
                errorReason: "preserved",
            });
            const untouched = [randomUUID(), randomUUID()];
            await repository.save([
                {
                    id: untouched[0],
                    tenantId: "tenant-a",
                    createdAt: cutoff,
                    offer,
                },
                {
                    id: untouched[1],
                    tenantId: "tenant-b",
                    createdAt: new Date("2025-01-01T12:00:00Z"),
                    offer,
                },
            ]);
            await expect(
                adapter.anonymizeSessionsCreatedBefore("tenant-a", cutoff),
            ).resolves.toBe(1);
            const stored = await repository.findOneByOrFail({ id: sessionId });
            expect(stored).toMatchObject({
                status: SessionStatus.Completed,
                requestId: "presentation",
                errorReason: "preserved",
            });
            const fields = [
                "credentials",
                "credentialPayload",
                "auth_queries",
                "offer",
                "requestObject",
                "responseEncryptionPrivateJwk",
            ] as const;
            const query = repository
                .createQueryBuilder("s")
                .where("s.id = :id", { id: sessionId });
            for (const field of fields) query.addSelect(`s.${field}`, field);
            const raw = await query.getRawOne();
            for (const field of fields) {
                expect(stored[field]).toBeNull();
                expect(raw[field]).toBeNull();
            }
            for (const id of untouched)
                expect(
                    (await repository.findOneByOrFail({ id })).offer,
                ).toEqual(offer);
            await expect(
                adapter.anonymizeSessionsCreatedBefore("tenant-a", cutoff),
            ).resolves.toBe(0);
        });

        it("guards empty orphan snapshots and applies default-cutoff deletion only outside the known tenant list", async () => {
            const repository = getDataSource().getRepository(Session);
            const cutoff = new Date("2025-01-02T12:00:00Z");
            const outsideSnapshot = randomUUID();
            const atCutoff = randomUUID();
            await repository.update(sessionId, {
                createdAt: new Date("2025-01-01T12:00:00Z"),
            });
            await repository.save([
                {
                    id: outsideSnapshot,
                    tenantId: "tenant-b",
                    createdAt: new Date("2025-01-01T12:00:00Z"),
                },
                { id: atCutoff, tenantId: "tenant-b", createdAt: cutoff },
            ]);
            await expect(
                adapter.deleteOrphanedSessionsCreatedBefore([], cutoff),
            ).resolves.toBe(0);
            expect(await repository.count()).toBe(3);
            // The maintenance port receives an authoritative snapshot of tenant IDs.
            await expect(
                adapter.deleteOrphanedSessionsCreatedBefore(
                    ["tenant-a"],
                    cutoff,
                ),
            ).resolves.toBe(1);
            expect(
                await repository.findOneBy({ id: outsideSnapshot }),
            ).toBeNull();
            expect(await repository.findOneBy({ id: atCutoff })).not.toBeNull();
            expect(
                await repository.findOneBy({ id: sessionId }),
            ).not.toBeNull();
        });

        it("counts tenant/status/type buckets using the existing null request-id distinction", async () => {
            const repository = getDataSource().getRepository(Session);
            await repository.save([
                {
                    id: randomUUID(),
                    tenantId: "tenant-a",
                    requestId: "presentation",
                    status: SessionStatus.Active,
                },
                {
                    id: randomUUID(),
                    tenantId: "tenant-a",
                    requestId: "",
                    status: SessionStatus.Active,
                },
                {
                    id: randomUUID(),
                    tenantId: "tenant-a",
                    requestId: "presentation",
                    status: SessionStatus.Completed,
                },
                {
                    id: randomUUID(),
                    tenantId: "tenant-b",
                    requestId: "presentation",
                    status: SessionStatus.Active,
                },
            ]);
            await expect(
                adapter.countSessionsForMaintenance(
                    "tenant-a",
                    "issuance",
                    SessionStatus.Active,
                ),
            ).resolves.toBe(1);
            await expect(
                adapter.countSessionsForMaintenance(
                    "tenant-a",
                    "verification",
                    SessionStatus.Active,
                ),
            ).resolves.toBe(2);
            await expect(
                adapter.countSessionsForMaintenance(
                    "tenant-a",
                    "verification",
                    SessionStatus.Completed,
                ),
            ).resolves.toBe(1);
            await expect(
                adapter.countSessionsForMaintenance(
                    "tenant-a",
                    "verification",
                    SessionStatus.Failed,
                ),
            ).resolves.toBe(0);
        });

        it("maps current tenant retention settings to a plain maintenance view and reloads changes", async () => {
            const tenants = getDataSource().getRepository(TenantEntity);
            const policies = new TypeOrmSessionRetentionPolicies(tenants);
            const initial = await policies.listForMaintenance();
            expect(initial).toEqual(
                expect.arrayContaining([
                    {
                        tenantId: "tenant-a",
                        ttlSeconds: undefined,
                        cleanupMode: undefined,
                    },
                ]),
            );
            expect(initial[0]).not.toBeInstanceOf(TenantEntity);
            await tenants.update("tenant-a", {
                sessionConfig: {
                    ttlSeconds: 120,
                    cleanupMode: SessionCleanupMode.Anonymize,
                },
            });
            expect(await policies.listForMaintenance()).toEqual(
                expect.arrayContaining([
                    {
                        tenantId: "tenant-a",
                        ttlSeconds: 120,
                        cleanupMode: SessionCleanupMode.Anonymize,
                    },
                ]),
            );
        });

        it.each(Object.values(SessionStatus))(
            "persists %s and applies terminal key cleanup without changing other fields",
            async (status) => {
                const repository = getDataSource().getRepository(Session);
                const key = { kty: "oct", k: "test-key-material" };
                await repository.update(sessionId, {
                    responseEncryptionPrivateJwk: key,
                    requestId: "presentation",
                    errorReason: "existing reason",
                });
                await adapter.changeState(
                    "tenant-a",
                    sessionId,
                    stateUpdate(status),
                );
                const stored = await repository.findOneByOrFail({
                    id: sessionId,
                });
                const terminal = [
                    SessionStatus.Completed,
                    SessionStatus.Failed,
                    SessionStatus.Expired,
                ].includes(status);
                expect(stored.status).toBe(status);
                expect(stored.responseEncryptionPrivateJwk).toEqual(
                    terminal ? null : key,
                );
                expect(stored.offer).toEqual(offer);
                expect(stored.errorReason).toBe("existing reason");
                const raw = await repository
                    .createQueryBuilder("s")
                    .select("s.responseEncryptionPrivateJwk", "key")
                    .where("s.id = :id", { id: sessionId })
                    .getRawOne();
                if (terminal) expect(raw.key).toBeNull();
                else expect(raw.key).not.toContain("test-key-material");
            },
        );

        it("does not update another tenant's session state or key", async () => {
            const repository = getDataSource().getRepository(Session);
            const key = { kty: "oct", k: "test-key-material" };
            await repository.update(sessionId, {
                responseEncryptionPrivateJwk: key,
            });
            await adapter.changeState(
                "tenant-b",
                sessionId,
                stateUpdate(SessionStatus.Failed),
            );
            expect(
                await repository.findOneByOrFail({ id: sessionId }),
            ).toMatchObject({
                status: SessionStatus.Active,
                responseEncryptionPrivateJwk: key,
            });
        });

        it("retains the existing no-op update behavior for a missing session", async () => {
            await expect(
                adapter.changeState(
                    "tenant-a",
                    randomUUID(),
                    stateUpdate(SessionStatus.Expired),
                ),
            ).resolves.toBeUndefined();
        });

        it("maps encrypted persistence to a plain offer view without eager tenant data", async () => {
            const view = await adapter.findCredentialOffer(
                "tenant-a",
                sessionId,
            );
            expect(view).toEqual({ offer });
            expect(view).not.toBeInstanceOf(Session);
            const raw = await getDataSource()
                .getRepository(Session)
                .createQueryBuilder("s")
                .select("s.offer", "offer")
                .where("s.id = :id", { id: sessionId })
                .getRawOne();
            expect(raw.offer).not.toContain("credential_issuer");
        });

        it("cannot read or consume another tenant's offer", async () => {
            await expect(
                adapter.findCredentialOffer("tenant-b", sessionId),
            ).resolves.toBeNull();
            await expect(
                adapter.consumeCredentialOffer("tenant-b", sessionId),
            ).resolves.toBe(false);
            await expect(
                adapter.findCredentialOffer("tenant-a", sessionId),
            ).resolves.toEqual({ offer });
        });

        it("distinguishes a missing session from a session without an offer", async () => {
            await expect(
                adapter.findCredentialOffer("tenant-a", randomUUID()),
            ).resolves.toBeNull();
            await expect(
                adapter.consumeCredentialOffer("tenant-a", randomUUID()),
            ).resolves.toBe(false);
            await getDataSource()
                .getRepository(Session)
                .update(sessionId, { offer: null });
            await expect(
                adapter.findCredentialOffer("tenant-a", sessionId),
            ).resolves.toEqual({ offer: null });
            await expect(
                adapter.consumeCredentialOffer("tenant-a", sessionId),
            ).resolves.toBe(false);
        });

        it("allows exactly one concurrent consumer and preserves the first timestamp on retries", async () => {
            const results = await Promise.all(
                Array.from({ length: 8 }, () =>
                    adapter.consumeCredentialOffer("tenant-a", sessionId),
                ),
            );
            expect(results.filter(Boolean)).toHaveLength(1);
            const stored = await getDataSource()
                .getRepository(Session)
                .findOneByOrFail({ id: sessionId });
            expect(stored.offer).toBeNull();
            expect(stored.consumedAt).toBeInstanceOf(Date);
            expect(stored.consumed).toBe(false);
            await expect(
                adapter.consumeCredentialOffer("tenant-a", sessionId),
            ).resolves.toBe(false);
            expect(
                (
                    await getDataSource()
                        .getRepository(Session)
                        .findOneByOrFail({ id: sessionId })
                ).consumedAt,
            ).toEqual(stored.consumedAt);
        });

        it("does not overwrite a consumption timestamp set by another part of the flow", async () => {
            const consumedAt = new Date("2026-01-01T12:00:00.000Z");
            await getDataSource()
                .getRepository(Session)
                .update(sessionId, { consumedAt, consumed: true });
            await expect(
                adapter.consumeCredentialOffer("tenant-a", sessionId),
            ).resolves.toBe(true);
            const stored = await getDataSource()
                .getRepository(Session)
                .findOneByOrFail({ id: sessionId });
            expect(stored.consumedAt).toEqual(consumedAt);
            expect(stored.consumed).toBe(true);
        });
    });
}
