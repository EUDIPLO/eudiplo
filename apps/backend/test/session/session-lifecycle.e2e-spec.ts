import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { SchedulerRegistry } from "@nestjs/schedule";
import { Test } from "@nestjs/testing";
import { firstValueFrom, timeout } from "rxjs";
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
            credentialPayload: { tx_code: "1234" },
        });
        const verification = vi.fn().mockRejectedValue({
            error: "invalid_request",
            error_description: "missing code",
        });
        const body = {
            grant_type: "urn:ietf:params:oauth:grant-type:pre-authorized_code",
            "pre-authorized_code": id,
        };
        vi.spyOn(
            app.get(OAUTH_AUTHORIZATION_SERVER_FACTORY),
            "forTenant",
        ).mockReturnValue({
            parseAccessTokenRequest: () => ({
                grant: { grantType: body.grant_type },
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
            verification.mockRejectedValue({
                error: "invalid_tx_code",
                error_description: "wrong code",
            });
            await expect(attempt()).rejects.toMatchObject({
                response: { error: "invalid_tx_code" },
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
        const nextEvent = firstValueFrom(
            app
                .get(events.SessionEventsService)
                .getSessionEvents(id)
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
        const nextEvent = firstValueFrom(
            app
                .get(events.SessionEventsService)
                .getSessionEvents(id)
                .pipe(timeout(2000)),
        );
        await app.get(cleanup.CleanupSessions).execute();
        expect(JSON.parse((await nextEvent).data).status).toBe("expired");
        expect(await repository.findOneByOrFail({ id })).toMatchObject({
            status: "expired",
            responseEncryptionPrivateJwk: null,
        });
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
