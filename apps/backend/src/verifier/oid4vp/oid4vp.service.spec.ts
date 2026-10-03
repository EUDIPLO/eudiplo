import { describe, expect, it, vi } from "vitest";
import { SessionStatus } from "../../session/domain/session-state.js";
import { SessionNotUsable } from "../../session/domain/session-usability.js";
import {
    CredentialVerificationFailedError,
    IncompletePresentationError,
} from "../presentations/application/verify-presentation-response.js";
import {
    claimValueMismatchViolation,
    missingClaimsViolation,
} from "../presentations/domain/dcql-claim-policy.js";
import { CompletePresentationResponse } from "./application/complete-presentation-response.js";
import { FailPresentationResponse } from "./application/fail-presentation-response.js";
import { ParseAuthorizationResponse } from "./application/parse-authorization-response.js";
import { ProcessVerifiedPresentation } from "./application/process-verified-presentation.js";
import { Oid4vpService } from "./oid4vp.service.js";

describe("OID4VP state mismatch handling", () => {
    it.each([undefined, "https://client.example/complete/{sessionId}"])(
        "records failure and clears the response key with redirect %s",
        async (redirectUri) => {
            const session = {
                id: "session",
                tenantId: "tenant",
                walletNonce: "expected",
                requestId: "presentation",
                consumed: false,
                redirectUri,
                responseEncryptionPrivateJwk: { kty: "oct", k: "secret" },
            };
            const update = vi.fn().mockResolvedValue(1);
            const announce = vi.fn();
            const logFlowError = vi.fn();
            const complete = vi.fn();
            const publish = vi.fn();
            const service = Object.assign(
                Object.create(Oid4vpService.prototype) as Oid4vpService,
                {
                    resolveSessionByNonce: vi.fn().mockResolvedValue(session),
                    logger: { debug: vi.fn(), warn: vi.fn() },
                    traceService: { getSpan: () => undefined },
                    encryptionService: {
                        decryptJweWithPrivateJwk: vi.fn().mockResolvedValue({
                            vp_token: { credential: ["vp"] },
                            state: "wrong",
                        }),
                    },
                    parseAuthorizationResponse:
                        new ParseAuthorizationResponse(),
                    settings: { logDecryptedResponse: false },
                    presentationConfigService: {
                        getPresentationConfig: vi.fn().mockResolvedValue({}),
                    },
                    verifyPresentation: vi.fn().mockResolvedValue([]),
                    resolveWebhookFromEndpoint: vi
                        .fn()
                        .mockResolvedValue(undefined),
                    auditLogger: {
                        logFlowStart: vi.fn(),
                        logCredentialVerification: vi.fn(),
                        logFlowError,
                    },
                    sessionStore: { updateForTenant: update },
                    processVerifiedPresentation:
                        new ProcessVerifiedPresentation(
                            new ParseAuthorizationResponse(),
                            { execute: complete },
                            { publish },
                        ),
                    failPresentationResponse: new FailPresentationResponse(
                        { updateIfUnconsumed: update },
                        { announce },
                        { publish },
                    ),
                },
            );
            const error = await service
                .getResponse({ response: "encrypted" }, "expected")
                .catch((error) => error);
            expect(error.getStatus()).toBe(400);
            const reason =
                "Presentation validation failed: State mismatch: response state does not match expected value";
            expect(update).toHaveBeenCalledExactlyOnceWith(
                "tenant",
                "session",
                {
                    status: "failed",
                    errorReason: reason,
                    responseEncryptionPrivateJwk: null,
                    outcome: { result: "failed", message: reason },
                },
            );
            expect(announce).toHaveBeenCalledExactlyOnceWith(
                {
                    id: "session",
                    tenantId: "tenant",
                    requestId: "presentation",
                },
                "failed",
            );
            expect(logFlowError).toHaveBeenCalledOnce();
            expect(complete).not.toHaveBeenCalled();
            expect(publish).not.toHaveBeenCalled();
            expect(error.getResponse()).toEqual(
                redirectUri
                    ? {
                          redirect_uri:
                              "https://client.example/complete/session?error=invalid_request&error_description=" +
                              encodeURIComponent(reason),
                      }
                    : {},
            );
        },
    );
});

describe("OID4VP concurrent response handling", () => {
    it("rejects the losing response without marking the completed session failed", async () => {
        const session = {
            id: "session",
            tenantId: "tenant",
            walletNonce: "expected",
            requestId: "presentation",
            consumed: false,
            responseEncryptionPrivateJwk: { kty: "oct", k: "secret" },
        };
        const update = vi.fn().mockResolvedValue(1);
        const announce = vi.fn();
        const publish = vi.fn();
        const service = Object.assign(
            Object.create(Oid4vpService.prototype) as Oid4vpService,
            {
                resolveSessionByNonce: vi.fn().mockResolvedValue(session),
                logger: { debug: vi.fn(), warn: vi.fn() },
                traceService: { getSpan: () => undefined },
                encryptionService: {
                    decryptJweWithPrivateJwk: vi.fn().mockResolvedValue({
                        vp_token: { credential: ["vp"] },
                        state: "expected",
                    }),
                },
                parseAuthorizationResponse: new ParseAuthorizationResponse(),
                settings: { logDecryptedResponse: false },
                presentationConfigService: {
                    getPresentationConfig: vi.fn().mockResolvedValue({}),
                },
                verifyPresentation: vi.fn().mockResolvedValue([]),
                resolveWebhookFromEndpoint: vi
                    .fn()
                    .mockResolvedValue(undefined),
                auditLogger: {
                    logFlowStart: vi.fn(),
                    logCredentialVerification: vi.fn(),
                    logFlowError: vi.fn(),
                },
                processVerifiedPresentation: new ProcessVerifiedPresentation(
                    new ParseAuthorizationResponse(),
                    new CompletePresentationResponse(
                        {
                            updateIfUnconsumed: vi
                                .fn()
                                .mockResolvedValue(false),
                        },
                        { announce },
                    ),
                    { publish },
                ),
                failPresentationResponse: new FailPresentationResponse(
                    { updateIfUnconsumed: update },
                    { announce },
                    { publish },
                ),
            },
        );

        const error = await service
            .getResponse({ response: "encrypted" }, "expected")
            .catch((error) => error);

        expect(error.getStatus()).toBe(400);
        expect(error.message).toBe(
            "The presentation offer has already been used",
        );
        expect(update).not.toHaveBeenCalled();
        expect(announce).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
    });
});

describe("OID4VP wallet error response handling", () => {
    const webhook = {
        url: "https://webhook.example/result",
        auth: { type: "none" as const },
    };

    function createService(
        options: {
            redirectUri?: string;
            parsedWebhook?: typeof webhook;
            webhookEndpointId?: string;
        } = {},
    ) {
        const session = {
            id: "session",
            tenantId: "tenant",
            walletNonce: "expected",
            requestId: "presentation",
            consumed: false,
            redirectUri: options.redirectUri,
            parsedWebhook: options.parsedWebhook,
            webhookEndpointId: options.webhookEndpointId,
            responseEncryptionPrivateJwk: { kty: "oct", k: "secret" },
        };
        const update = vi.fn().mockResolvedValue(true);
        const updateForTenant = vi.fn();
        const announce = vi.fn();
        const publish = vi.fn().mockResolvedValue({});
        const logFlowError = vi.fn();
        const resolveWebhookFromEndpoint = vi.fn().mockResolvedValue(undefined);
        const getPresentationConfig = vi
            .fn()
            .mockResolvedValue({ webhookEndpointId: "config-endpoint" });
        const decrypt = vi.fn().mockResolvedValue({
            error: "access_denied",
            error_description: "User declined",
            state: "expected",
        });
        const service = Object.assign(
            Object.create(Oid4vpService.prototype) as Oid4vpService,
            {
                resolveSessionByNonce: vi.fn().mockResolvedValue(session),
                logger: { debug: vi.fn(), warn: vi.fn() },
                traceService: { getSpan: () => undefined },
                encryptionService: { decryptJweWithPrivateJwk: decrypt },
                parseAuthorizationResponse: new ParseAuthorizationResponse(),
                auditLogger: { logFlowError },
                presentationConfigService: { getPresentationConfig },
                resolveWebhookFromEndpoint,
                failPresentationResponse: new FailPresentationResponse(
                    { updateForTenant, updateIfUnconsumed: update },
                    { announce },
                    { publish },
                ),
            },
        );
        return {
            service,
            session,
            update,
            updateForTenant,
            announce,
            publish,
            logFlowError,
            resolveWebhookFromEndpoint,
            getPresentationConfig,
            decrypt,
        };
    }

    const walletOutcome = {
        result: "failed",
        error: "access_denied",
        message: "Wallet error: access_denied: User declined",
    };

    it.each([
        [
            "plain",
            { error: "access_denied", error_description: "User declined" },
        ],
        ["encrypted", { response: "encrypted" }],
    ])(
        "marks the session failed and returns without an exception for a %s error response",
        async (_kind, body) => {
            const { service, update, updateForTenant, announce, publish } =
                createService();

            await expect(
                service.getResponse(body, "expected"),
            ).resolves.toEqual({});
            expect(update).toHaveBeenCalledExactlyOnceWith(
                "tenant",
                "session",
                {
                    status: "failed",
                    errorReason: "Wallet error: access_denied: User declined",
                    failureCode: "access_denied",
                    outcome: walletOutcome,
                    responseEncryptionPrivateJwk: null,
                },
            );
            expect(updateForTenant).not.toHaveBeenCalled();
            expect(announce).toHaveBeenCalledExactlyOnceWith(
                {
                    id: "session",
                    tenantId: "tenant",
                    requestId: "presentation",
                },
                "failed",
            );
            // No webhook configured on the session or the presentation config.
            expect(publish).not.toHaveBeenCalled();
        },
    );

    it("returns the redirect_uri with the wallet error for an encrypted error response", async () => {
        const { service } = createService({
            redirectUri: "https://client.example/complete/{sessionId}",
        });

        await expect(
            service.getResponse({ response: "encrypted" }, "expected"),
        ).resolves.toEqual({
            redirect_uri:
                "https://client.example/complete/session?error=access_denied&error_description=User%20declined",
        });
    });

    it("does not overwrite a session a concurrent presentation already completed", async () => {
        const { service, update, announce, publish } = createService({
            parsedWebhook: webhook,
        });
        update.mockResolvedValue(false);

        const error = await service
            .getResponse({ error: "access_denied" }, "expected")
            .catch((error) => error);

        expect(error.getStatus()).toBe(400);
        expect(announce).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
    });

    it("reports the declined presentation to the webhook without credentials", async () => {
        const { service, session, publish } = createService({
            parsedWebhook: webhook,
        });

        await expect(
            service.getResponse({ response: "encrypted" }, "expected"),
        ).resolves.toEqual({});
        expect(publish).toHaveBeenCalledExactlyOnceWith({
            webhook,
            session,
            status: "failed",
            outcome: walletOutcome,
        });
    });

    it("resolves the webhook endpoint of the presentation config like the success path", async () => {
        const {
            service,
            publish,
            resolveWebhookFromEndpoint,
            getPresentationConfig,
        } = createService();
        resolveWebhookFromEndpoint.mockResolvedValue(webhook);

        await service.getResponse({ error: "access_denied" }, "expected");

        expect(getPresentationConfig).toHaveBeenCalledWith(
            "presentation",
            "tenant",
        );
        expect(resolveWebhookFromEndpoint).toHaveBeenCalledWith(
            "config-endpoint",
            "tenant",
        );
        expect(publish).toHaveBeenCalledOnce();
    });

    it("uses a redirectUri returned by the webhook for the error redirect", async () => {
        const { service, publish } = createService({
            redirectUri: "https://client.example/complete/{sessionId}",
            parsedWebhook: webhook,
        });
        publish.mockResolvedValue({
            redirectUri: "https://override.example/declined/{sessionId}?a=1",
        });

        await expect(
            service.getResponse({ error: "access_denied" }, "expected"),
        ).resolves.toEqual({
            redirect_uri:
                "https://override.example/declined/session?a=1&error=access_denied",
        });
    });

    it("keeps the failed session and the 200 answer when webhook delivery fails", async () => {
        const { service, update, publish, logFlowError } = createService({
            parsedWebhook: webhook,
        });
        publish.mockRejectedValue(new Error("webhook down"));

        await expect(
            service.getResponse({ error: "access_denied" }, "expected"),
        ).resolves.toEqual({});
        expect(update).toHaveBeenCalledOnce();
        expect(logFlowError).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ message: "webhook down" }),
            { action: "webhook_callback" },
        );
    });

    it("still records the failure when the webhook cannot be resolved", async () => {
        const { service, update, publish, getPresentationConfig } =
            createService();
        getPresentationConfig.mockRejectedValue(new Error("config deleted"));

        await expect(
            service.getResponse({ error: "access_denied" }, "expected"),
        ).resolves.toEqual({});
        expect(update).toHaveBeenCalledOnce();
        expect(publish).not.toHaveBeenCalled();
    });
});

describe("OID4VP verification failure reporting", () => {
    const webhook = {
        url: "https://webhook.example/result",
        auth: { type: "none" as const },
    };

    function createService(failure: unknown, redirectUri?: string) {
        const session = {
            id: "session",
            tenantId: "tenant",
            walletNonce: "expected",
            requestId: "presentation",
            consumed: false,
            redirectUri,
            parsedWebhook: webhook,
            responseEncryptionPrivateJwk: { kty: "oct", k: "secret" },
        };
        const update = vi.fn().mockResolvedValue(true);
        const publish = vi.fn().mockResolvedValue({});
        const logFlowError = vi.fn();
        const service = Object.assign(
            Object.create(Oid4vpService.prototype) as Oid4vpService,
            {
                resolveSessionByNonce: vi.fn().mockResolvedValue(session),
                logger: { debug: vi.fn(), warn: vi.fn(), assign: vi.fn() },
                traceService: { getSpan: () => undefined },
                encryptionService: {
                    decryptJweWithPrivateJwk: vi.fn().mockResolvedValue({
                        vp_token: { mdl: ["device-response"] },
                        state: "expected",
                    }),
                },
                parseAuthorizationResponse: new ParseAuthorizationResponse(),
                settings: { logDecryptedResponse: false },
                presentationConfigService: {
                    getPresentationConfig: vi.fn().mockResolvedValue({}),
                },
                // The real verifyPresentation maps the use case error.
                verifyPresentationResponse: {
                    execute: vi.fn().mockRejectedValue(failure),
                },
                auditLogger: {
                    logFlowStart: vi.fn(),
                    logCredentialVerification: vi.fn(),
                    logFlowError,
                },
                failPresentationResponse: new FailPresentationResponse(
                    { updateIfUnconsumed: update },
                    { announce: vi.fn() },
                    { publish },
                ),
            },
        );
        return { service, session, update, publish, logFlowError };
    }

    it("classifies mDOC verification failures into failureCode and the per-credential outcome", async () => {
        const { service, session, update, publish, logFlowError } =
            createService(
                new CredentialVerificationFailedError(
                    "mdl",
                    {
                        type: "trust_chain_not_trusted",
                        reason: "CN=Issuer is not in the configured list",
                        message:
                            'mDOC verification failed for credential "mdl": certificate chain does not match any trusted entity',
                    },
                    { format: "mso_mdoc", docType: "org.iso.18013.5.1.mDL" },
                ),
            );

        const error = await service
            .getResponse({ response: "encrypted" }, "expected")
            .catch((error) => error);

        expect(error.getStatus()).toBe(400);
        const message = "The credential issuer is not in the trusted list.";
        const outcome = {
            result: "failed",
            error: "trust_chain_not_trusted",
            message,
            credentials: [
                {
                    id: "mdl",
                    format: "mso_mdoc",
                    docType: "org.iso.18013.5.1.mDL",
                    verified: false,
                    error: "trust_chain_not_trusted",
                    message,
                },
            ],
        };
        expect(update).toHaveBeenCalledExactlyOnceWith("tenant", "session", {
            status: "failed",
            errorReason: message,
            failureCode: "trust_chain_not_trusted",
            responseEncryptionPrivateJwk: null,
            outcome,
        });
        // The verbose reason stays in the audit log.
        expect(logFlowError).toHaveBeenCalledWith(
            expect.anything(),
            new Error("CN=Issuer is not in the configured list"),
            {
                action: "process_presentation_response",
                errorCode: "trust_chain_not_trusted",
            },
        );
        expect(publish).toHaveBeenCalledExactlyOnceWith({
            webhook,
            session,
            status: "failed",
            outcome,
        });
    });

    it("falls back to verification_error for an unclassified credential failure", async () => {
        const { service, update } = createService(
            new CredentialVerificationFailedError(
                "mdl",
                { message: "mDOC verification failed" },
                { format: "mso_mdoc" },
            ),
        );

        await service
            .getResponse({ response: "encrypted" }, "expected")
            .catch(() => undefined);

        expect(update.mock.calls[0][2]).toMatchObject({
            failureCode: "verification_error",
            outcome: {
                error: "verification_error",
                credentials: [
                    { id: "mdl", verified: false, error: "verification_error" },
                ],
            },
        });
    });

    it("reports claim value mismatches with the claim_value_mismatch code", async () => {
        const { service, session, update, publish, logFlowError } =
            createService(
                new IncompletePresentationError(
                    claimValueMismatchViolation("pid", [
                        "age_equal_or_over.18",
                    ]),
                ),
            );

        const error = await service
            .getResponse({ response: "encrypted" }, "expected")
            .catch((error) => error);

        expect(error.getStatus()).toBe(400);
        // Names the claim path, never the disclosed value.
        const message =
            "Disclosed claim values do not match the requested values for credential 'pid': age_equal_or_over.18";
        const outcome = {
            result: "failed",
            error: "claim_value_mismatch",
            message,
        };
        expect(update).toHaveBeenCalledExactlyOnceWith("tenant", "session", {
            status: "failed",
            errorReason: message,
            failureCode: "claim_value_mismatch",
            responseEncryptionPrivateJwk: null,
            outcome,
        });
        expect(logFlowError).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            {
                action: "process_presentation_response",
                errorCode: "claim_value_mismatch",
            },
        );
        expect(publish).toHaveBeenCalledExactlyOnceWith({
            webhook,
            session,
            status: "failed",
            outcome,
        });
    });

    it("keeps missing claims without a failure code", async () => {
        const { service, update } = createService(
            new IncompletePresentationError(
                missingClaimsViolation("pid", ["given_name"]),
            ),
        );

        await service
            .getResponse({ response: "encrypted" }, "expected")
            .catch(() => undefined);

        const message =
            "Missing required claims for credential 'pid': given_name";
        expect(update.mock.calls[0][2]).toEqual({
            status: "failed",
            errorReason: message,
            responseEncryptionPrivateJwk: null,
            outcome: { result: "failed", message },
        });
    });

    it("keeps unclassified errors without a failure code", async () => {
        const { service, update } = createService(new Error("boom"));

        await service
            .getResponse({ response: "encrypted" }, "expected")
            .catch(() => undefined);

        expect(update.mock.calls[0][2]).toEqual({
            status: "failed",
            errorReason: "Presentation validation failed: boom",
            responseEncryptionPrivateJwk: null,
            outcome: {
                result: "failed",
                message: "Presentation validation failed: boom",
            },
        });
    });

    it("uses a redirectUri returned by the failure webhook and keeps HTTP 400", async () => {
        const { service, publish } = createService(
            new Error("boom"),
            "https://client.example/complete/{sessionId}",
        );
        publish.mockResolvedValue({
            redirectUri: "https://override.example/failed",
        });

        const error = await service
            .getResponse({ response: "encrypted" }, "expected")
            .catch((error) => error);

        expect(error.getStatus()).toBe(400);
        expect(error.getResponse()).toEqual({
            redirect_uri: `https://override.example/failed?error=invalid_request&error_description=${encodeURIComponent("Presentation validation failed: boom")}`,
        });
    });

    it("keeps the failed session when the failure webhook cannot be delivered", async () => {
        const { service, update, publish, logFlowError } = createService(
            new Error("boom"),
        );
        publish.mockRejectedValue(new Error("webhook down"));

        const error = await service
            .getResponse({ response: "encrypted" }, "expected")
            .catch((error) => error);

        expect(error.getStatus()).toBe(400);
        expect(error.getResponse()).toEqual({});
        expect(update).toHaveBeenCalledOnce();
        expect(logFlowError).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ message: "webhook down" }),
            { action: "webhook_callback" },
        );
    });
});

describe("OID4VP expired or finished requests", () => {
    function createService(session: Record<string, unknown>) {
        const decrypt = vi.fn();
        const fail = vi.fn();
        const service = Object.assign(
            Object.create(Oid4vpService.prototype) as Oid4vpService,
            {
                resolveSessionByNonce: vi.fn().mockResolvedValue({
                    id: "session",
                    tenantId: "tenant",
                    requestId: "presentation",
                    consumed: false,
                    status: SessionStatus.Active,
                    ...session,
                }),
                logger: { debug: vi.fn() },
                traceService: { getSpan: () => undefined },
                encryptionService: { decryptJweWithPrivateJwk: decrypt },
                failPresentationResponse: { execute: fail },
            },
        );
        return { service, decrypt, fail };
    }

    it.each([
        [
            "past its expiry",
            { expiresAt: new Date(Date.now() - 1000) },
            "The session has expired",
        ],
        [
            "already expired",
            { status: SessionStatus.Expired },
            "The session has expired",
        ],
        [
            "already failed",
            { status: SessionStatus.Failed },
            "The session is already failed",
        ],
    ])(
        "rejects a response to a request %s without touching the session",
        async (_case, session, message) => {
            const { service, decrypt, fail } = createService(session);

            const error = await service
                .getResponse({ response: "encrypted" }, "nonce")
                .catch((error) => error);

            expect(error.getStatus()).toBe(400);
            expect(error.message).toBe(message);
            expect(decrypt).not.toHaveBeenCalled();
            expect(fail).not.toHaveBeenCalled();
        },
    );

    it("maps an expired request object fetch to HTTP 400", async () => {
        const { service } = createService({});
        Object.assign(service, {
            retrievePresentationRequest: {
                execute: vi
                    .fn()
                    .mockRejectedValue(
                        new SessionNotUsable(SessionStatus.Expired),
                    ),
            },
        });

        const error = await service
            .getAuthorizationRequest("nonce", "https://wallet.example")
            .catch((error) => error);

        expect(error.getStatus()).toBe(400);
        expect(error.message).toBe("The session has expired");
    });
});

describe("OID4VP request creation", () => {
    function createService(updateForTenant: ReturnType<typeof vi.fn>) {
        return Object.assign(
            Object.create(Oid4vpService.prototype) as Oid4vpService,
            {
                presentationConfigService: {
                    getPresentationConfig: vi.fn().mockResolvedValue({}),
                },
                certService: {
                    find: vi.fn().mockResolvedValue({}),
                    getCertHash: vi.fn().mockReturnValue("hash"),
                },
                settings: { publicUrl: "https://verifier.example" },
                resolveWebhookFromEndpoint: vi
                    .fn()
                    .mockResolvedValue(undefined),
                createSession: {
                    execute: vi.fn(async (data: { id: string }) => data),
                },
                createAuthorizationRequest: vi
                    .fn()
                    .mockResolvedValue("signed.request.object"),
                sessionStore: { updateForTenant },
            },
        );
    }

    it("returns the offer only after the request object is stored", async () => {
        let storeRequestObject!: () => void;
        const updateForTenant = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    storeRequestObject = resolve;
                }),
        );
        const service = createService(updateForTenant);

        let settled = false;
        const offer = service
            .createRequest("presentation", {}, "tenant", true, "https://rp")
            .finally(() => {
                settled = true;
            });

        await vi.waitFor(() => expect(updateForTenant).toHaveBeenCalled());
        const [, sessionId] = updateForTenant.mock.calls[0] as unknown[];
        expect(updateForTenant).toHaveBeenCalledExactlyOnceWith(
            "tenant",
            sessionId,
            { requestObject: "signed.request.object" },
        );
        await new Promise((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);

        storeRequestObject();
        await expect(offer).resolves.toMatchObject({ session: sessionId });
    });

    it("rejects the offer when the request object cannot be stored", async () => {
        const updateForTenant = vi
            .fn()
            .mockRejectedValue(new Error("database unavailable"));
        const service = createService(updateForTenant);

        await expect(
            service.createRequest(
                "presentation",
                {},
                "tenant",
                true,
                "https://rp",
            ),
        ).rejects.toThrow("database unavailable");
        expect(updateForTenant).toHaveBeenCalledExactlyOnceWith(
            "tenant",
            expect.any(String),
            { requestObject: "signed.request.object" },
        );
    });
});
