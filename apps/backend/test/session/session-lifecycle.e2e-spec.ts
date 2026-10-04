import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { SchedulerRegistry } from "@nestjs/schedule";
import { Test } from "@nestjs/testing";
import { Oauth2ServerErrorResponseError } from "@openid4vc/oauth2";
import { lastValueFrom, timeout, toArray } from "rxjs";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe("session lifecycle module wiring", () => {
    let app: INestApplication;
    let folder: string;
    let db: DataSource;
    let entities: typeof import("../../src/session/entities/session.entity.js");
    let domain: typeof import("../../src/session/domain/session-state.js");
    let application: typeof import("../../src/session/application/change-session-state.js");
    let events: typeof import("../../src/session/session-events.service.js");
    let cleanup: typeof import("../../src/session/application/cleanup-sessions.js");
    let eventPort: typeof import("../../src/session/ports/session-event-publisher.js");

    beforeAll(async () => {
        folder = mkdtempSync(join(tmpdir(), "eudiplo-session-lifecycle-"));
        vi.stubEnv("DB_TYPE", "sqlite");
        vi.stubEnv("FOLDER", folder);
        vi.stubEnv("CONFIG_IMPORT_MODE", "disabled");
        vi.resetModules();
        const { AppModule } = await import("../../src/app.module.js");
        entities = await import("../../src/session/entities/session.entity.js");
        domain = await import("../../src/session/domain/session-state.js");
        application = await import(
            "../../src/session/application/change-session-state.js"
        );
        events = await import("../../src/session/session-events.service.js");
        cleanup = await import(
            "../../src/session/application/cleanup-sessions.js"
        );
        eventPort = await import(
            "../../src/session/ports/session-event-publisher.js"
        );
        const { TenantEntity } = await import(
            "../../src/auth/tenant/entities/tenant.entity.js"
        );
        const module = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = module.createNestApplication();
        await app.init();
        db = app.get(DataSource);
        await db.getRepository(TenantEntity).save({ id: "tenant-a" });
    }, 60_000);

    afterAll(async () => {
        await app?.close();
        if (folder) rmSync(folder, { recursive: true, force: true });
        vi.unstubAllEnvs();
    });

    it("resolves configured claims through production persistence and delivery wiring", async () => {
        const { CREDENTIAL_CLAIMS_PROVIDER } = await import(
            "../../src/issuer/configuration/credentials/domain/credential-claims.js"
        );
        const { CredentialConfig, CredentialFormat } = await import(
            "../../src/issuer/configuration/credentials/entities/credential.entity.js"
        );
        const { AttributeProviderEntity } = await import(
            "../../src/issuer/configuration/attribute-provider/entities/attribute-provider.entity.js"
        );
        const { WebhookService } = await import(
            "../../src/webhook/webhook.service.js"
        );
        const id = randomUUID();
        const configs = db.getRepository(CredentialConfig);
        const providers = db.getRepository(AttributeProviderEntity);
        await providers.save({
            id,
            tenantId: "tenant-a",
            name: "Claims",
            url: "https://claims.example",
            auth: { type: "none" },
        });
        await configs.save({
            id,
            tenantId: "tenant-a",
            config: { format: CredentialFormat.SD_JWT_VC, display: [] },
            fields: [],
            attributeProviderId: id,
        });
        const delivery = vi
            .spyOn(app.get(WebhookService), "sendClaimsWebhook")
            .mockResolvedValue({ [id]: { name: "Alice" } });
        try {
            const provider = app.get<
                import("../../src/issuer/configuration/credentials/domain/credential-claims.js").CredentialClaimsProvider
            >(CREDENTIAL_CLAIMS_PROVIDER);
            const session = {
                id: "claims-session",
                tenantId: "tenant-a",
            } as import("../../src/session/domain/session-data.js").SessionData;
            await expect(
                provider.resolveClaims({
                    credentialConfigurationId: id,
                    session,
                }),
            ).resolves.toEqual({ deferred: false, claims: { name: "Alice" } });
            expect(delivery).toHaveBeenCalledWith(
                expect.objectContaining({
                    webhook: {
                        url: "https://claims.example",
                        auth: { type: "none" },
                    },
                    session: "claims-session",
                    credentialConfigurationId: id,
                }),
            );
            delivery.mockClear();
            await expect(
                provider.resolveClaims({
                    credentialConfigurationId: id,
                    session: { ...session, tenantId: "tenant-b" },
                }),
            ).rejects.toMatchObject({
                code: "credential_configuration_not_found",
            });
            expect(delivery).not.toHaveBeenCalled();
        } finally {
            delivery.mockRestore();
            await configs.delete({ id, tenantId: "tenant-a" });
            await providers.delete({ id, tenantId: "tenant-a" });
        }
    });

    it("wires tenant-scoped listing and deletion through the session controller", async () => {
        const { SessionController } = await import(
            "../../src/session/session.controller.js"
        );
        const controller = app.get(SessionController);
        const repository = db.getRepository(entities.Session);
        const id = randomUUID();
        await repository.save({ id, tenantId: "tenant-a" });
        const token = { entity: { id: "tenant-a" } } as Parameters<
            typeof controller.getAllSessions
        >[0];
        const otherTenant = { entity: { id: "tenant-b" } } as Parameters<
            typeof controller.getAllSessions
        >[0];
        const query = { page: 1, pageSize: 25 };
        expect(await controller.getAllSessions(token, query)).toMatchObject({
            items: [{ id }],
            total: 1,
            totalPages: 1,
        });
        expect(
            await controller.getAllSessions(otherTenant, query),
        ).toMatchObject({ items: [], total: 0, totalPages: 0 });
        await controller.deleteSession(id, otherTenant);
        expect(await repository.existsBy({ id })).toBe(true);
        await controller.deleteSession(id, token);
        await expect(
            controller.deleteSession(id, token),
        ).resolves.toBeUndefined();
        expect(await repository.existsBy({ id })).toBe(false);
    });

    it("records failed transaction codes through the production module wiring", async () => {
        const { RecordFailedTxCodeAttempt } = await import(
            "../../src/session/application/record-failed-tx-code-attempt.js"
        );
        const useCase = app.get(RecordFailedTxCodeAttempt);
        const id = randomUUID();
        const repository = db.getRepository(entities.Session);
        await repository.save({ id, tenantId: "tenant-a" });
        expect(await useCase.execute("tenant-a", id, 2)).toEqual({
            failedAttempts: 1,
            locked: false,
        });
        expect(await useCase.execute("tenant-a", id, 2)).toEqual({
            failedAttempts: 2,
            locked: true,
        });
        await repository.delete({ id });
    });

    it("preserves token errors and lockout around the real attempt counter", async () => {
        const { AuthorizeController } = await import(
            "../../src/issuer/issuance/oid4vci/authorization/authorize/authorize.controller.js"
        );
        const { BuildBuiltInAuthorizationServerMetadata } = await import(
            "../../src/issuer/issuance/oid4vci/authorization/application/build-built-in-authorization-server-metadata.js"
        );
        const { OAUTH_AUTHORIZATION_SERVER_FACTORY } = await import(
            "../../src/issuer/issuance/oid4vci/authorization/ports/oauth-authorization-server-factory.js"
        );
        const { IssuanceService } = await import(
            "../../src/issuer/configuration/issuance/issuance.service.js"
        );
        const { WalletAttestationService } = await import(
            "../../src/trust/wallet-attestation.service.js"
        );
        const authorize = app.get(AuthorizeController);
        const id = randomUUID();
        const repository = db.getRepository(entities.Session);
        await repository.save({
            id,
            tenantId: "tenant-a",
            authorization_code: id,
            credentialPayload: { flow: "pre_authorized_code", tx_code: "1234" },
        });
        // Rejections use the real library error shape (code in errorResponse).
        const verification = vi.fn().mockRejectedValue(
            new Oauth2ServerErrorResponseError({
                error: "invalid_request",
                error_description: "Missing required 'tx_code' in request",
            }),
        );
        const body: Record<string, string> = {
            grant_type: "urn:ietf:params:oauth:grant-type:pre-authorized_code",
            "pre-authorized_code": id,
        };
        vi.spyOn(
            app.get(OAUTH_AUTHORIZATION_SERVER_FACTORY),
            "forTenant",
        ).mockReturnValue({
            parseAccessTokenRequest: () => ({
                grant: {
                    grantType: body.grant_type,
                    preAuthorizedCode: id,
                    txCode: body.tx_code,
                },
                accessTokenRequest: body,
            }),
            verifyPreAuthorizedCodeAccessTokenRequest: verification,
        } as never);
        vi.spyOn(
            app.get(BuildBuiltInAuthorizationServerMetadata),
            "execute",
        ).mockResolvedValue({
            issuer: "https://issuer.example",
        } as never);
        vi.spyOn(
            app.get(IssuanceService),
            "getIssuanceConfiguration",
        ).mockResolvedValue({ txCodeMaxAttempts: 2 } as never);
        vi.spyOn(
            app.get(WalletAttestationService),
            "verifyWalletAttestation",
        ).mockResolvedValue(undefined);
        const request = {
            method: "POST",
            url: "/token",
            headers: {},
        } as Parameters<typeof authorize.token>[1];
        const attempt = () => authorize.token(body, request, "tenant-a");
        try {
            await expect(attempt()).rejects.toMatchObject({
                response: { error: "invalid_request" },
                status: 400,
            });
            expect(
                (await repository.findOneByOrFail({ id })).txCodeFailedAttempts,
            ).toBe(0);
            body.tx_code = "9999";
            verification.mockRejectedValue(
                new Oauth2ServerErrorResponseError({
                    error: "invalid_grant",
                    error_description: "Invalid 'tx_code' provided",
                }),
            );
            await expect(attempt()).rejects.toMatchObject({
                response: {
                    error: "invalid_grant",
                    error_description: "Invalid 'tx_code' provided",
                },
                status: 400,
            });
            await expect(attempt()).rejects.toMatchObject({
                response: {
                    error: "invalid_grant",
                    error_description:
                        "Too many failed tx_code attempts. The pre-authorized code has been invalidated.",
                },
                status: 400,
            });
            verification.mockClear();
            await expect(attempt()).rejects.toMatchObject({
                response: { error: "invalid_grant" },
                status: 400,
            });
            expect(verification).not.toHaveBeenCalled();
            expect(
                (await repository.findOneByOrFail({ id })).txCodeFailedAttempts,
            ).toBe(2);
        } finally {
            vi.restoreAllMocks();
            await repository.delete({ id });
        }
    });

    it("creates, retrieves, updates and binds plain session data through the module", async () => {
        const { CreateSession } = await import(
            "../../src/session/application/create-session.js"
        );
        const { SessionStore } = await import(
            "../../src/session/application/session-store.js"
        );
        const { ResolveExternalAuthorizationSession } = await import(
            "../../src/session/application/resolve-external-authorization-session.js"
        );
        const { SessionController } = await import(
            "../../src/session/session.controller.js"
        );
        const createSession = app.get(CreateSession);
        const sessionStore = app.get(SessionStore);
        const id = randomUUID();
        await createSession.execute({
            id,
            tenantId: "tenant-a",
            authorizationServerId: "external",
            authorization_code: "module-code",
        });
        try {
            expect(
                await sessionStore.getByAuthorizationCode(
                    "tenant-a",
                    "module-code",
                ),
            ).toMatchObject({ id });
            await expect(
                sessionStore.getByAuthorizationCode("tenant-b", "module-code"),
            ).rejects.toThrow("Session not found");
            await expect(
                sessionStore.getByAuthorizationCode("tenant-a", undefined),
            ).rejects.toThrow("Session not found");
            await sessionStore.updateForTenant("tenant-a", id, {
                requestObject: "request",
            });
            const token = { entity: { id: "tenant-a" } } as Parameters<
                InstanceType<typeof SessionController>["getSession"]
            >[1];
            const detail = await app
                .get(SessionController)
                .getSession(id, token);
            expect(detail).not.toBeInstanceOf(entities.Session);
            expect(detail).toMatchObject({
                id,
                requestObject: "request",
                tenant: { id: "tenant-a" },
            });
            const bound = await app
                .get(ResolveExternalAuthorizationSession)
                .execute(
                    "tenant-a",
                    "issuer",
                    "subject",
                    "external",
                    "session_id",
                    id,
                );
            expect(bound.externalSubject).toBeNull();
            expect(
                await sessionStore.getForTenant("tenant-a", id),
            ).toMatchObject({
                externalIssuer: "issuer",
                externalSubject: "subject",
            });
        } finally {
            await db.getRepository(entities.Session).delete({ id });
        }
    });

    it("publishes the existing SSE shape after committing terminal state and key cleanup", async () => {
        const id = randomUUID();
        const repository = db.getRepository(entities.Session);
        await repository.save({
            id,
            tenantId: "tenant-a",
            responseEncryptionPrivateJwk: { kty: "oct", k: "private-material" },
        });
        // The stream starts with the stored status and completes after the
        // terminal one, so its last event is the transition under test.
        const nextEvent = lastValueFrom(
            app
                .get(events.SessionEventsService)
                .getSessionEvents("tenant-a", id)
                .pipe(timeout(2000)),
        );
        const emitted: unknown[] = [];
        const persistedAtEvent: Promise<unknown>[] = [];
        const listener = (event: { sessionId: string }) => {
            emitted.push(event);
            persistedAtEvent.push(
                repository.findOneByOrFail({ id: event.sessionId }),
            );
        };
        const emitter = app.get(EventEmitter2);
        emitter.on(eventPort.SESSION_STATUS_CHANGED, listener);
        try {
            await app
                .get(application.ChangeSessionState)
                .execute(
                    { id, tenantId: "tenant-a" },
                    domain.SessionStatus.Completed,
                );
            const message = await nextEvent;
            expect(JSON.parse(message.data)).toEqual({
                id,
                status: "completed",
                updatedAt: expect.any(String),
            });
            expect(emitted).toEqual([
                {
                    sessionId: id,
                    status: "completed",
                    updatedAt: expect.any(Date),
                },
            ]);
            expect(await persistedAtEvent[0]).toMatchObject({
                status: "completed",
                responseEncryptionPrivateJwk: null,
            });
        } finally {
            emitter.off(eventPort.SESSION_STATUS_CHANGED, listener);
        }
    });

    it("streams the stored status first and completes on a change made without an in-process event", async () => {
        const { SESSION_EVENTS_POLL_INTERVAL_MS } = events;
        const id = randomUUID();
        const repository = db.getRepository(entities.Session);
        await repository.save({
            id,
            tenantId: "tenant-a",
            status: domain.SessionStatus.Fetched,
        });
        try {
            const stream = lastValueFrom(
                app
                    .get(events.SessionEventsService)
                    .getSessionEvents("tenant-a", id)
                    .pipe(
                        toArray(),
                        timeout(SESSION_EVENTS_POLL_INTERVAL_MS * 3),
                    ),
            );
            // Another replica completes the session: only the database changes.
            await new Promise((resolve) => setTimeout(resolve, 100));
            await repository.update(
                { id },
                { status: domain.SessionStatus.Failed },
            );
            const statuses = (await stream).map(
                (message) => JSON.parse(message.data).status,
            );
            expect(statuses).toEqual(["fetched", "failed"]);

            // A late subscriber gets the terminal status and the end of stream.
            const late = await lastValueFrom(
                app
                    .get(events.SessionEventsService)
                    .getSessionEvents("tenant-a", id)
                    .pipe(toArray(), timeout(2000)),
            );
            expect(late.map((message) => JSON.parse(message.data))).toEqual([
                { id, status: "failed", updatedAt: expect.any(String) },
            ]);

            // Reads are tenant-scoped: another tenant's stream ends at once.
            await expect(
                lastValueFrom(
                    app
                        .get(events.SessionEventsService)
                        .getSessionEvents("tenant-b", id)
                        .pipe(toArray(), timeout(2000)),
                ),
            ).resolves.toEqual([]);
        } finally {
            await repository.delete({ id });
        }
    });

    it("announces presentation completion once for concurrent responses and announces failures", async () => {
        const { CompletePresentationResponse } = await import(
            "../../src/verifier/oid4vp/application/complete-presentation-response.js"
        );
        const { FailPresentationResponse } = await import(
            "../../src/verifier/oid4vp/application/fail-presentation-response.js"
        );
        const repository = db.getRepository(entities.Session);
        const completedId = randomUUID();
        const failedId = randomUUID();
        await repository.save(
            [completedId, failedId].map((id) => ({
                id,
                tenantId: "tenant-a",
                requestId: "presentation",
                responseEncryptionPrivateJwk: {
                    kty: "oct",
                    k: "private-material",
                },
            })),
        );
        const emitted: { sessionId: string; status: string }[] = [];
        const listener = (event: { sessionId: string; status: string }) => {
            if ([completedId, failedId].includes(event.sessionId)) {
                emitted.push(event);
            }
        };
        const emitter = app.get(EventEmitter2);
        emitter.on(eventPort.SESSION_STATUS_CHANGED, listener);
        try {
            const complete = app.get(CompletePresentationResponse, {
                strict: false,
            });
            const results = await Promise.allSettled(
                ["first", "second"].map((responseCode) =>
                    complete.execute({
                        tenantId: "tenant-a",
                        sessionId: completedId,
                        requestId: "presentation",
                        credentials: [],
                        responseCode,
                    }),
                ),
            );
            expect(
                results.filter((result) => result.status === "fulfilled"),
            ).toHaveLength(1);
            await app.get(FailPresentationResponse, { strict: false }).execute({
                tenantId: "tenant-a",
                sessionId: failedId,
                requestId: "presentation",
                message: "invalid",
            });
            expect(emitted).toEqual([
                expect.objectContaining({
                    sessionId: completedId,
                    status: "completed",
                }),
                expect.objectContaining({
                    sessionId: failedId,
                    status: "failed",
                }),
            ]);
            expect(
                await repository.findOneByOrFail({ id: completedId }),
            ).toMatchObject({
                status: "completed",
                consumed: true,
                responseEncryptionPrivateJwk: null,
            });
            expect(
                await repository.findOneByOrFail({ id: failedId }),
            ).toMatchObject({
                status: "failed",
                responseEncryptionPrivateJwk: null,
            });
        } finally {
            emitter.off(eventPort.SESSION_STATUS_CHANGED, listener);
            await repository.delete([completedId, failedId]);
        }
    });

    it("registers the maintenance interval and expires overdue presentations via the use case", async () => {
        expect(
            app.get(SchedulerRegistry).doesExist("interval", "tidyUpSessions"),
        ).toBe(true);
        const id = randomUUID();
        const repository = db.getRepository(entities.Session);
        await repository.save({
            id,
            tenantId: "tenant-a",
            requestId: "presentation",
            expiresAt: new Date("2020-01-01"),
            responseEncryptionPrivateJwk: { kty: "oct", k: "private-material" },
        });
        // The stream starts with the stored status and completes after the
        // terminal one, so its last event is the transition under test.
        const nextEvent = lastValueFrom(
            app
                .get(events.SessionEventsService)
                .getSessionEvents("tenant-a", id)
                .pipe(timeout(2000)),
        );
        await app.get(cleanup.CleanupSessions).execute();
        expect(JSON.parse((await nextEvent).data).status).toBe("expired");
        expect(await repository.findOneByOrFail({ id })).toMatchObject({
            status: "expired",
            responseEncryptionPrivateJwk: null,
        });
    });
    it("expires by time of day and only unredeemed issuance offers", async () => {
        const repository = db.getRepository(entities.Session);
        const ids = {
            laterToday: randomUUID(),
            overdueOffer: randomUUID(),
            redeemedOffer: randomUUID(),
            fetchedOffer: randomUUID(),
        };
        await repository.save([
            {
                // A date-only column stored midnight, so this expired early.
                id: ids.laterToday,
                tenantId: "tenant-a",
                requestId: "presentation",
                expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            },
            {
                id: ids.overdueOffer,
                tenantId: "tenant-a",
                expiresAt: new Date(Date.now() - 1000),
            },
            {
                id: ids.redeemedOffer,
                tenantId: "tenant-a",
                expiresAt: new Date(Date.now() - 1000),
                consumed: true,
            },
            {
                id: ids.fetchedOffer,
                tenantId: "tenant-a",
                expiresAt: new Date(Date.now() - 1000),
                status: domain.SessionStatus.Fetched,
            },
        ]);
        try {
            await app.get(cleanup.CleanupSessions).execute();
            const status = async (id: string) =>
                (await repository.findOneByOrFail({ id })).status;
            expect(await status(ids.laterToday)).toBe("active");
            expect(await status(ids.overdueOffer)).toBe("expired");
            expect(await status(ids.redeemedOffer)).toBe("active");
            expect(await status(ids.fetchedOffer)).toBe("fetched");
        } finally {
            await repository.delete(Object.values(ids));
        }
    });

    it("keeps an expired presentation expired when a late response arrives", async () => {
        const { CompletePresentationResponse, PresentationAlreadyConsumed } =
            await import(
                "../../src/verifier/oid4vp/application/complete-presentation-response.js"
            );
        const { FailPresentationResponse } = await import(
            "../../src/verifier/oid4vp/application/fail-presentation-response.js"
        );
        const repository = db.getRepository(entities.Session);
        const markedExpired = randomUUID();
        const overdue = randomUUID();
        await repository.save([
            {
                id: markedExpired,
                tenantId: "tenant-a",
                requestId: "presentation",
                status: domain.SessionStatus.Expired,
            },
            {
                id: overdue,
                tenantId: "tenant-a",
                requestId: "presentation",
                expiresAt: new Date(Date.now() - 1000),
            },
        ]);
        const emitted: string[] = [];
        const listener = (event: { sessionId: string }) => {
            if (
                ([markedExpired, overdue] as string[]).includes(event.sessionId)
            )
                emitted.push(event.sessionId);
        };
        const emitter = app.get(EventEmitter2);
        emitter.on(eventPort.SESSION_STATUS_CHANGED, listener);
        try {
            for (const sessionId of [markedExpired, overdue]) {
                await expect(
                    app
                        .get(CompletePresentationResponse, { strict: false })
                        .execute({
                            tenantId: "tenant-a",
                            sessionId,
                            requestId: "presentation",
                            credentials: [],
                            responseCode: "late",
                        }),
                ).rejects.toBeInstanceOf(PresentationAlreadyConsumed);
                await app
                    .get(FailPresentationResponse, { strict: false })
                    .execute({
                        tenantId: "tenant-a",
                        sessionId,
                        requestId: "presentation",
                        message: "late",
                    });
            }
            expect(emitted).toEqual([]);
            expect(
                await repository.findOneByOrFail({ id: markedExpired }),
            ).toMatchObject({ status: "expired", consumed: false });
            expect(
                await repository.findOneByOrFail({ id: overdue }),
            ).toMatchObject({ status: "active", consumed: false });
        } finally {
            emitter.off(eventPort.SESSION_STATUS_CHANGED, listener);
            await repository.delete([markedExpired, overdue]);
        }
    });

    it("reports database session counts through the sessions gauge, including deletions", async () => {
        const { OtelSessionMetrics } = await import(
            "../../src/session/adapters/otel-session-metrics.js"
        );
        const metrics = app.get(OtelSessionMetrics);
        const repository = db.getRepository(entities.Session);
        const tenantId = `metrics-${randomUUID()}`;
        const { TenantEntity } = await import(
            "../../src/auth/tenant/entities/tenant.entity.js"
        );
        await db.getRepository(TenantEntity).save({ id: tenantId });
        const collect = () => {
            const observed: Record<string, number> = {};
            metrics.observe({
                observe: (
                    value: number,
                    attributes: Record<string, string>,
                ) => {
                    if (attributes.tenant_id === tenantId)
                        observed[
                            `${attributes.session_type}/${attributes.status}`
                        ] = value;
                },
            } as never);
            return observed;
        };
        const ids = [randomUUID(), randomUUID(), randomUUID()];
        await repository.save([
            { id: ids[0], tenantId },
            { id: ids[1], tenantId, requestId: "presentation" },
            {
                id: ids[2],
                tenantId,
                requestId: "presentation",
                status: domain.SessionStatus.Fetched,
            },
        ]);
        try {
            await metrics.refresh();
            expect(collect()).toMatchObject({
                "issuance/active": 1,
                "verification/active": 1,
                "verification/fetched": 1,
                "verification/completed": 0,
            });
            await repository.delete(ids[1]);
            await metrics.refresh();
            expect(collect()).toMatchObject({
                "issuance/active": 1,
                "verification/active": 0,
                "verification/fetched": 1,
            });
        } finally {
            await repository.delete(ids);
            await db.getRepository(TenantEntity).delete({ id: tenantId });
        }
    });

    it("applies tenant retention overrides through the production wiring and reloads policy changes", async () => {
        const { TenantEntity } = await import(
            "../../src/auth/tenant/entities/tenant.entity.js"
        );
        const { SessionCleanupMode } = await import(
            "../../src/session/domain/session-retention.js"
        );
        const tenants = db.getRepository(TenantEntity);
        await tenants.save([
            {
                id: "retention-full",
                sessionConfig: {
                    ttlSeconds: 600,
                    cleanupMode: SessionCleanupMode.Full,
                },
            },
            {
                id: "retention-anonymize",
                sessionConfig: {
                    ttlSeconds: 120,
                    cleanupMode: SessionCleanupMode.Anonymize,
                },
            },
        ]);
        const oldFull = randomUUID();
        const recentFull = randomUUID();
        const oldAnonymous = randomUUID();
        const recentAnonymous = randomUUID();
        const sessions = db.getRepository(entities.Session);
        await sessions.save([
            {
                id: oldFull,
                tenantId: "retention-full",
                createdAt: new Date(Date.now() - 601_000),
                requestObject: "private",
            },
            {
                id: recentFull,
                tenantId: "retention-full",
                createdAt: new Date(Date.now() - 60_000),
                requestObject: "private",
            },
            {
                id: oldAnonymous,
                tenantId: "retention-anonymize",
                createdAt: new Date(Date.now() - 121_000),
                requestObject: "private",
            },
            {
                id: recentAnonymous,
                tenantId: "retention-anonymize",
                createdAt: new Date(Date.now() - 60_000),
                requestObject: "private",
            },
        ]);
        await app.get(cleanup.CleanupSessions).execute();
        expect(await sessions.findOneBy({ id: oldFull })).toBeNull();
        expect(
            (await sessions.findOneByOrFail({ id: recentFull })).requestObject,
        ).toBe("private");
        expect(
            (await sessions.findOneByOrFail({ id: oldAnonymous }))
                .requestObject,
        ).toBeNull();
        expect(
            (await sessions.findOneByOrFail({ id: recentAnonymous }))
                .requestObject,
        ).toBe("private");
        await tenants.update("retention-anonymize", {
            sessionConfig: {
                ttlSeconds: 120,
                cleanupMode: SessionCleanupMode.Full,
            },
        });
        await app.get(cleanup.CleanupSessions).execute();
        expect(await sessions.findOneBy({ id: oldAnonymous })).toBeNull();
        expect(
            await sessions.findOneBy({ id: recentAnonymous }),
        ).not.toBeNull();
    });
});
