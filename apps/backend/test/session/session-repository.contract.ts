import { randomUUID } from "node:crypto";
import type { CredentialOfferObject } from "@openid4vc/openid4vci";
import { DataSource } from "typeorm";
import { beforeEach, describe, expect, it } from "vitest";
import { ClientEntity } from "../../src/auth/client/entities/client.entity.js";
import { TenantEntity } from "../../src/auth/tenant/entities/tenant.entity.js";
import { hashAuthorizationCode } from "../../src/issuer/issuance/oid4vci/authorization/domain/token-grant-rules.js";
import { TypeOrmSessionRepository } from "../../src/session/adapters/typeorm-session.repository.js";
import { TypeOrmSessionRetentionPolicies } from "../../src/session/adapters/typeorm-session-retention-policies.js";
import type { SessionListQuery } from "../../src/session/domain/session-list.js";
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

export { initializeTestEncryption } from "../persistence/test-encryption.js";

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

        it("stores expiresAt with its time of day", async () => {
            const expiresAt = new Date("2030-05-06T07:08:09.123Z");
            await adapter.updateForTenant("tenant-a", sessionId, {
                expiresAt,
            });
            expect(
                (await adapter.findForTenant("tenant-a", sessionId))?.expiresAt,
            ).toEqual(expiresAt);
        });

        it.each([
            SessionStatus.Completed,
            SessionStatus.Failed,
            SessionStatus.Expired,
        ])(
            "does not apply an unconsumed update to a %s session",
            async (status) => {
                await adapter.updateForTenant("tenant-a", sessionId, {
                    status,
                });
                await expect(
                    adapter.updateUnconsumedForTenant("tenant-a", sessionId, {
                        status: SessionStatus.Completed,
                        consumed: true,
                        responseCode: "late",
                    }),
                ).resolves.toBe(false);
                expect(
                    await adapter.findForTenant("tenant-a", sessionId),
                ).toMatchObject({ status, consumed: false });
            },
        );

        it("applies an unconsumed update only before the session expires", async () => {
            await adapter.updateForTenant("tenant-a", sessionId, {
                status: SessionStatus.Fetched,
                expiresAt: new Date(Date.now() - 1_000),
            });
            await expect(
                adapter.updateUnconsumedForTenant("tenant-a", sessionId, {
                    status: SessionStatus.Completed,
                    consumed: true,
                }),
            ).resolves.toBe(false);
            expect(
                await adapter.findForTenant("tenant-a", sessionId),
            ).toMatchObject({ status: SessionStatus.Fetched, consumed: false });

            await adapter.updateForTenant("tenant-a", sessionId, {
                expiresAt: new Date(Date.now() + 60_000),
            });
            await expect(
                adapter.updateUnconsumedForTenant("tenant-a", sessionId, {
                    status: SessionStatus.Completed,
                    consumed: true,
                }),
            ).resolves.toBe(true);
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

        it("consumes a request_uri once, only within the tenant scope and before it expires", async () => {
            const now = new Date();
            await adapter.updateForTenant("tenant-a", sessionId, {
                request_uri: "uri",
                request_uri_expires_at: new Date(now.getTime() + 60_000),
            });
            // Use the expiry as read back, like the authorization endpoint.
            const { request_uri_expires_at: expiresAt } =
                (await adapter.findByRequestUri("tenant-a", "uri"))!;

            await expect(
                adapter.consumeRequestUri(
                    "tenant-b",
                    sessionId,
                    expiresAt!,
                    now,
                ),
            ).resolves.toBe(false);
            await expect(
                adapter.consumeRequestUri(
                    "tenant-a",
                    sessionId,
                    expiresAt!,
                    new Date(expiresAt!.getTime() + 1),
                ),
            ).resolves.toBe(false);
            await expect(
                adapter.consumeRequestUri(
                    "tenant-a",
                    sessionId,
                    new Date(expiresAt!.getTime() + 1_000),
                    now,
                ),
            ).resolves.toBe(false);

            // Concurrent callers with differing clocks: exactly one wins.
            const results = await Promise.all(
                Array.from({ length: 8 }, (_, index) =>
                    adapter.consumeRequestUri(
                        "tenant-a",
                        sessionId,
                        expiresAt!,
                        new Date(now.getTime() + index * 1_000),
                    ),
                ),
            );
            expect(results.filter(Boolean)).toHaveLength(1);
            const winner = results.indexOf(true);
            const stored = await adapter.findByRequestUri("tenant-a", "uri");
            expect(stored?.request_uri_expires_at?.getTime()).toBe(
                now.getTime() + winner * 1_000,
            );
            await expect(
                adapter.consumeRequestUri(
                    "tenant-a",
                    sessionId,
                    expiresAt!,
                    now,
                ),
            ).resolves.toBe(false);
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
                    updatedAt: new Date("2025-01-03"),
                    expiresAt: null,
                    requestId: null,
                    failureCode: null,
                    reference: null,
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
                    status: [SessionStatus.Completed],
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
                    status: [SessionStatus.Active],
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

        describe("list filters", () => {
            const ids = {
                pidOffer: "3f2a0000-0000-4000-8000-000000000001",
                mdlOffer: "3f2b0000-0000-4000-8000-000000000002",
                failedAge: "9c000000-0000-4000-8000-000000000003",
                pendingAge: "9c100000-0000-4000-8000-000000000004",
                otherTenant: "3f2a0000-0000-4000-8000-000000000005",
            };
            const list = (query: Partial<SessionListQuery>) =>
                adapter
                    .listForTenant("tenant-a", {
                        page: 1,
                        pageSize: 10,
                        sortBy: "id",
                        sortOrder: "asc",
                        ...query,
                    })
                    .then(({ items, total }) => ({
                        total,
                        ids: items.map((item) => item.id),
                    }));

            beforeEach(async () => {
                const repository = getDataSource().getRepository(Session);
                await repository.clear();
                await repository.save([
                    {
                        id: ids.pidOffer,
                        tenantId: "tenant-a",
                        createdAt: new Date("2026-10-02T08:00:00Z"),
                        updatedAt: new Date("2026-10-02T08:05:00Z"),
                        credentialConfigurationIds: ["pid", "pid-mdoc"],
                        authorization_code:
                            hashAuthorizationCode("pre-auth-code"),
                        reference: "order-4711",
                    },
                    {
                        id: ids.mdlOffer,
                        tenantId: "tenant-a",
                        createdAt: new Date("2026-10-02T09:00:00Z"),
                        updatedAt: new Date("2026-10-02T09:00:00Z"),
                        status: SessionStatus.Fetched,
                        credentialConfigurationIds: ["mdl"],
                    },
                    {
                        id: ids.failedAge,
                        tenantId: "tenant-a",
                        createdAt: new Date("2026-10-02T10:00:00Z"),
                        updatedAt: new Date("2026-10-02T10:30:00Z"),
                        requestId: "age-check",
                        walletNonce: "11111111-1111-4111-8111-111111111111",
                        status: SessionStatus.Failed,
                        failureCode: "trust_chain_not_trusted",
                    },
                    {
                        id: ids.pendingAge,
                        tenantId: "tenant-a",
                        createdAt: new Date("2026-10-02T11:00:00Z"),
                        updatedAt: new Date("2026-10-02T11:00:00Z"),
                        requestId: "age-check",
                        expiresAt: new Date("2026-10-02T11:05:00Z"),
                        reference: "case-42",
                    },
                    {
                        id: ids.otherTenant,
                        tenantId: "tenant-b",
                        createdAt: new Date("2026-10-02T08:00:00Z"),
                        credentialConfigurationIds: ["pid"],
                        authorization_code:
                            hashAuthorizationCode("pre-auth-code"),
                        reference: "order-4711",
                        requestId: "age-check",
                        failureCode: "trust_chain_not_trusted",
                    },
                ]);
            });

            it("filters by creation and update time ranges, bounds included", async () => {
                expect(
                    await list({
                        createdFrom: new Date("2026-10-02T09:00:00Z"),
                        createdTo: new Date("2026-10-02T10:00:00Z"),
                    }),
                ).toEqual({ total: 2, ids: [ids.mdlOffer, ids.failedAge] });
                expect(
                    await list({
                        updatedFrom: new Date("2026-10-02T10:30:00Z"),
                    }),
                ).toEqual({ total: 2, ids: [ids.failedAge, ids.pendingAge] });
                expect(
                    await list({ updatedTo: new Date("2026-10-02T08:05:00Z") }),
                ).toEqual({ total: 1, ids: [ids.pidOffer] });
            });

            it("matches any of several statuses", async () => {
                expect(
                    await list({
                        status: [SessionStatus.Active, SessionStatus.Fetched],
                    }),
                ).toEqual({
                    total: 3,
                    ids: [ids.pidOffer, ids.mdlOffer, ids.pendingAge],
                });
            });

            it("filters by configuration, failure code and id prefix", async () => {
                expect(await list({ requestId: "age-check" })).toEqual({
                    total: 2,
                    ids: [ids.failedAge, ids.pendingAge],
                });
                expect(
                    await list({ credentialConfigurationId: "pid" }),
                ).toEqual({ total: 1, ids: [ids.pidOffer] });
                expect(
                    await list({ credentialConfigurationId: "pid-mdoc" }),
                ).toEqual({ total: 1, ids: [ids.pidOffer] });
                // Only whole configuration ids match.
                expect(await list({ credentialConfigurationId: "pi" })).toEqual(
                    { total: 0, ids: [] },
                );
                expect(
                    await list({ failureCode: "trust_chain_not_trusted" }),
                ).toEqual({ total: 1, ids: [ids.failedAge] });
                expect(await list({ id: "3F2" })).toEqual({
                    total: 2,
                    ids: [ids.pidOffer, ids.mdlOffer],
                });
                expect(await list({ id: ids.mdlOffer })).toEqual({
                    total: 1,
                    ids: [ids.mdlOffer],
                });
            });

            it("combines filters and counts the total over all pages", async () => {
                const query = {
                    type: "presentation" as const,
                    createdFrom: new Date("2026-10-02T09:30:00Z"),
                    status: [SessionStatus.Active, SessionStatus.Failed],
                };
                expect(await list(query)).toEqual({
                    total: 2,
                    ids: [ids.failedAge, ids.pendingAge],
                });
                expect(await list({ ...query, pageSize: 1, page: 2 })).toEqual({
                    total: 2,
                    ids: [ids.pendingAge],
                });
                expect(
                    await list({
                        ...query,
                        failureCode: "trust_chain_not_trusted",
                    }),
                ).toEqual({ total: 1, ids: [ids.failedAge] });
                expect(
                    await list({ type: "issuance", requestId: "age-check" }),
                ).toEqual({ total: 0, ids: [] });
            });

            it("searches by id prefix, wallet nonce, pre-authorized code and reference", async () => {
                expect(await list({ q: "9c1" })).toEqual({
                    total: 1,
                    ids: [ids.pendingAge],
                });
                expect(
                    await list({ q: "11111111-1111-4111-8111-111111111111" }),
                ).toEqual({ total: 1, ids: [ids.failedAge] });
                expect(await list({ q: "pre-auth-code" })).toEqual({
                    total: 1,
                    ids: [ids.pidOffer],
                });
                expect(await list({ q: "case-42" })).toEqual({
                    total: 1,
                    ids: [ids.pendingAge],
                });
                expect(await list({ q: "case" })).toEqual({
                    total: 0,
                    ids: [],
                });
                expect(
                    await list({ q: "order-4711", requestId: "age-check" }),
                ).toEqual({ total: 0, ids: [] });
            });

            it("finds the session behind a pasted offer or request link", async () => {
                const offerUri = `https://issuer.example/issuers/tenant-a/vci/credential-offers/${ids.mdlOffer}`;
                expect(
                    await list({
                        q: `openid-credential-offer://?credential_offer_uri=${encodeURIComponent(offerUri)}`,
                    }),
                ).toEqual({ total: 1, ids: [ids.mdlOffer] });
                const requestUri =
                    "https://verifier.example/presentations/11111111-1111-4111-8111-111111111111/oid4vp/request/no-redirect";
                expect(
                    await list({
                        q: `openid4vp://?client_id=x509_hash%3Aabc&request_uri=${encodeURIComponent(requestUri)}`,
                    }),
                ).toEqual({ total: 1, ids: [ids.failedAge] });
                // A link to an unknown or malformed session matches nothing.
                expect(
                    await list({
                        q: "https://issuer.example/vci/credential-offers/3f2a",
                    }),
                ).toEqual({ total: 0, ids: [] });
            });

            it("never returns another tenant's sessions", async () => {
                for (const query of [
                    { q: "pre-auth-code" },
                    { q: "order-4711" },
                    { id: "3f2a" },
                    { credentialConfigurationId: "pid" },
                    { requestId: "age-check" },
                ])
                    expect((await list(query)).ids).not.toContain(
                        ids.otherTenant,
                    );
            });

            it("sorts by update time and returns the summary fields", async () => {
                const page = await adapter.listForTenant("tenant-a", {
                    page: 1,
                    pageSize: 10,
                    sortBy: "updatedAt",
                    sortOrder: "desc",
                });
                expect(page.items.map((item) => item.id)).toEqual([
                    ids.pendingAge,
                    ids.failedAge,
                    ids.mdlOffer,
                    ids.pidOffer,
                ]);
                expect(page.items[0]).toEqual({
                    id: ids.pendingAge,
                    status: SessionStatus.Active,
                    createdAt: new Date("2026-10-02T11:00:00Z"),
                    updatedAt: new Date("2026-10-02T11:00:00Z"),
                    expiresAt: new Date("2026-10-02T11:05:00Z"),
                    requestId: "age-check",
                    failureCode: null,
                    reference: "case-42",
                });
            });
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

        it("reads and deletes a session only within the requested type", async () => {
            const repository = getDataSource().getRepository(Session);
            const presentationId = randomUUID();
            await repository.save({
                id: presentationId,
                tenantId: "tenant-a",
                requestId: "pid-request",
            });

            expect(
                await adapter.findForTenant("tenant-a", sessionId, "issuance"),
            ).toMatchObject({ id: sessionId });
            expect(
                await adapter.findForTenant(
                    "tenant-a",
                    sessionId,
                    "presentation",
                ),
            ).toBeNull();
            expect(
                await adapter.findForTenant(
                    "tenant-a",
                    presentationId,
                    "presentation",
                ),
            ).toMatchObject({ id: presentationId });
            expect(
                await adapter.findForTenant(
                    "tenant-a",
                    presentationId,
                    "issuance",
                ),
            ).toBeNull();

            await adapter.deleteForTenant(
                "tenant-a",
                presentationId,
                "issuance",
            );
            await adapter.deleteForTenant(
                "tenant-a",
                sessionId,
                "presentation",
            );
            expect(await repository.existsBy({ id: presentationId })).toBe(
                true,
            );
            expect(await repository.existsBy({ id: sessionId })).toBe(true);

            await adapter.deleteForTenant(
                "tenant-a",
                presentationId,
                "presentation",
            );
            await adapter.deleteForTenant("tenant-a", sessionId, "issuance");
            expect(await repository.existsBy({ id: presentationId })).toBe(
                false,
            );
            expect(await repository.existsBy({ id: sessionId })).toBe(false);
        });

        it("finds overdue open presentations and unredeemed offers across tenants, without returning entities or sensitive data", async () => {
            const repository = getDataSource().getRepository(Session);
            const past = new Date("2025-01-01");
            const future = new Date("2025-01-03");
            const active = randomUUID();
            const fetched = randomUUID();
            const offer = randomUUID();
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
                    id: offer,
                    tenantId: "tenant-a",
                    expiresAt: past,
                    status: SessionStatus.Active,
                },
                // Redeemed offers: the wallet holds tokens or credentials.
                {
                    id: randomUUID(),
                    tenantId: "tenant-a",
                    expiresAt: past,
                    status: SessionStatus.Active,
                    consumed: true,
                },
                {
                    id: randomUUID(),
                    tenantId: "tenant-a",
                    expiresAt: past,
                    status: SessionStatus.Fetched,
                },
                {
                    id: randomUUID(),
                    tenantId: "tenant-a",
                    expiresAt: future,
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
                ].flatMap((status) => [
                    {
                        id: randomUUID(),
                        tenantId: "tenant-a",
                        requestId: "terminal",
                        expiresAt: past,
                        status,
                    },
                    {
                        id: randomUUID(),
                        tenantId: "tenant-a",
                        expiresAt: past,
                        status,
                    },
                ]),
            ]);
            const result = await adapter.findExpiredSessionsForMaintenance(
                new Date("2025-01-02T12:00:00Z"),
            );
            expect(result).toHaveLength(3);
            expect(result).toEqual(
                expect.arrayContaining([
                    { id: active, tenantId: "tenant-a", requestId: "a" },
                    { id: fetched, tenantId: "tenant-b", requestId: "b" },
                    { id: offer, tenantId: "tenant-a", requestId: null },
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
            const counts = await adapter.countSessionsByStatus();
            // The session from beforeEach is an active issuance of tenant-a.
            expect(counts).toHaveLength(4);
            expect(counts).toEqual(
                expect.arrayContaining([
                    {
                        tenantId: "tenant-a",
                        kind: "issuance",
                        status: SessionStatus.Active,
                        count: 1,
                    },
                    {
                        tenantId: "tenant-a",
                        kind: "verification",
                        status: SessionStatus.Active,
                        count: 2,
                    },
                    {
                        tenantId: "tenant-a",
                        kind: "verification",
                        status: SessionStatus.Completed,
                        count: 1,
                    },
                    {
                        tenantId: "tenant-b",
                        kind: "verification",
                        status: SessionStatus.Active,
                        count: 1,
                    },
                ]),
            );
            await repository.clear();
            await expect(adapter.countSessionsByStatus()).resolves.toEqual([]);
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
                    SessionStatus.Cancelled,
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

        it("changes the state only from an expected status, within the tenant scope", async () => {
            const repository = getDataSource().getRepository(Session);
            const key = { kty: "oct", k: "test-key-material" };
            await repository.update(sessionId, {
                responseEncryptionPrivateJwk: key,
            });
            await expect(
                adapter.changeStateFrom(
                    "tenant-b",
                    sessionId,
                    [SessionStatus.Active],
                    stateUpdate(SessionStatus.Fetched),
                ),
            ).resolves.toBe(false);
            await expect(
                adapter.changeStateFrom(
                    "tenant-a",
                    sessionId,
                    [SessionStatus.Fetched],
                    stateUpdate(SessionStatus.Expired),
                ),
            ).resolves.toBe(false);
            await expect(
                adapter.changeStateFrom(
                    "tenant-a",
                    sessionId,
                    [],
                    stateUpdate(SessionStatus.Expired),
                ),
            ).resolves.toBe(false);
            const results = await Promise.all(
                Array.from({ length: 4 }, () =>
                    adapter.changeStateFrom(
                        "tenant-a",
                        sessionId,
                        [SessionStatus.Active],
                        stateUpdate(SessionStatus.Fetched),
                    ),
                ),
            );
            expect(results.filter(Boolean)).toHaveLength(1);
            await expect(
                adapter.changeStateFrom(
                    "tenant-a",
                    sessionId,
                    [SessionStatus.Active, SessionStatus.Fetched],
                    stateUpdate(SessionStatus.Expired),
                ),
            ).resolves.toBe(true);
            expect(
                await repository.findOneByOrFail({ id: sessionId }),
            ).toMatchObject({
                status: SessionStatus.Expired,
                responseEncryptionPrivateJwk: null,
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
            expect(view).toEqual({ offer, status: SessionStatus.Active });
            expect(view).not.toBeInstanceOf(Session);
            const expiresAt = new Date("2030-01-01T00:00:00.000Z");
            await adapter.updateForTenant("tenant-a", sessionId, {
                status: SessionStatus.Fetched,
                expiresAt,
            });
            await expect(
                adapter.findCredentialOffer("tenant-a", sessionId),
            ).resolves.toEqual({
                offer,
                status: SessionStatus.Fetched,
                expiresAt,
            });
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
            ).resolves.toEqual({ offer, status: SessionStatus.Active });
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
            ).resolves.toEqual({ offer: null, status: SessionStatus.Active });
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
