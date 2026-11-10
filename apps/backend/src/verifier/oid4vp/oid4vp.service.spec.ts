import { errors as joseErrors } from "jose";
import { describe, expect, it, vi } from "vitest";
import { EncryptedResponseRejectedError } from "../../crypto/encryption/encrypted-response-rejected.error.js";
import { CryptoImplementationService } from "../../crypto/key/crypto-implementation/crypto-implementation.service.js";
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
import { VerifierMetadataService } from "./verifier-metadata.service.js";

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
                    outcome: {
                        result: "failed",
                        source: "verifier",
                        message: reason,
                    },
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
        source: "wallet",
        error: "access_denied",
        message: "Wallet error: access_denied: User declined",
        description: "User declined",
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

    it("rejects an error response that also carries a vp_token and leaves the session open", async () => {
        const { service, decrypt, update, updateForTenant, publish } =
            createService();
        decrypt.mockResolvedValue({
            error: "access_denied",
            vp_token: { credential: ["vp"] },
            state: "expected",
        });

        const error = await service
            .getResponse({ response: "encrypted" }, "expected")
            .catch((error) => error);

        expect(error.getStatus()).toBe(400);
        expect(error.message).toMatch(/^Invalid authorization response: /);
        expect(update).not.toHaveBeenCalled();
        expect(updateForTenant).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
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
            source: "verifier",
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
            source: "verifier",
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
            outcome: { result: "failed", source: "verifier", message },
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
                source: "verifier",
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
            .getAuthorizationRequest("nonce")
            .catch((error) => error);

        expect(error.getStatus()).toBe(400);
        expect(error.message).toBe("The session has expired");
    });
});

describe("OID4VP encrypted response rejection", () => {
    function createService(decryptError: unknown) {
        const service = Object.assign(
            Object.create(Oid4vpService.prototype) as Oid4vpService,
            {
                resolveSessionByNonce: vi.fn().mockResolvedValue({
                    id: "session",
                    tenantId: "tenant",
                    requestId: "presentation",
                    consumed: false,
                    status: SessionStatus.Active,
                }),
                logger: { debug: vi.fn() },
                traceService: { getSpan: () => undefined },
                encryptionService: {
                    decryptJweWithPrivateJwk: vi
                        .fn()
                        .mockRejectedValue(decryptError),
                },
            },
        );
        return { service };
    }

    it("answers a rejected JWE with HTTP 400", async () => {
        const rejected = new EncryptedResponseRejectedError(
            new joseErrors.JWTClaimValidationFailed(
                '"nbf" claim timestamp check failed',
                {},
                "nbf",
                "check_failed",
            ),
        );
        const { service } = createService(rejected);

        const error = await service
            .getResponse({ response: "encrypted" }, "nonce")
            .catch((error) => error);

        expect(error.getStatus()).toBe(400);
        expect(error.message).toBe(
            'Could not decrypt the authorization response: "nbf" claim timestamp check failed',
        );
    });

    it("keeps other decryption failures as server errors", async () => {
        const keyLookupFailure = new Error("database unavailable");
        const { service } = createService(keyLookupFailure);

        await expect(
            service.getResponse({ response: "encrypted" }, "nonce"),
        ).rejects.toBe(keyLookupFailure);
    });
});

describe("OID4VP request creation", () => {
    function createService(
        updateForTenant: ReturnType<typeof vi.fn>,
        presentationConfig: Record<string, unknown> = {
            allowedOrigins: ["https://rp"],
        },
    ) {
        return Object.assign(
            Object.create(Oid4vpService.prototype) as Oid4vpService,
            {
                presentationConfigService: {
                    getPresentationConfig: vi
                        .fn()
                        .mockResolvedValue(presentationConfig),
                },
                certService: {
                    find: vi.fn().mockResolvedValue({ keyId: "access-a" }),
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
                federationIdentity: {
                    forTenant: vi.fn().mockResolvedValue({
                        entityId: "https://verifier.example/issuers/tenant",
                        includeTrustChain: false,
                    }),
                },
            },
        );
    }

    it("uses the tenant's federation entity id for clientIdScheme openid_federation", async () => {
        const service = createService(vi.fn().mockResolvedValue(undefined));

        const offer = await service.createRequest(
            "presentation",
            { clientIdScheme: "openid_federation" },
            "tenant",
            false,
        );

        expect(new URLSearchParams(offer.uri).get("client_id")).toBe(
            "openid_federation:https://verifier.example/issuers/tenant",
        );
    });

    it("refuses clientIdScheme openid_federation for a stored entity id that is no Entity Identifier", async () => {
        const service = createService(vi.fn().mockResolvedValue(undefined));
        (
            service as unknown as {
                federationIdentity: { forTenant: ReturnType<typeof vi.fn> };
            }
        ).federationIdentity.forTenant.mockResolvedValue({
            entityId: "verifier",
            includeTrustChain: false,
            entityIdProblem: "federation.entityId 'verifier' is not a URL",
        });

        const error = await service
            .createRequest(
                "presentation",
                { clientIdScheme: "openid_federation" },
                "tenant",
                false,
            )
            .catch((error) => error);

        expect(error.getStatus()).toBe(400);
        expect(error.message).toContain(
            "federation.entityId 'verifier' is not a URL",
        );
    });

    it("refuses clientIdScheme openid_federation without a federation verifier entity", async () => {
        const service = createService(vi.fn().mockResolvedValue(undefined));
        (
            service as unknown as {
                federationIdentity: { forTenant: ReturnType<typeof vi.fn> };
            }
        ).federationIdentity.forTenant.mockResolvedValue(undefined);

        const error = await service
            .createRequest(
                "presentation",
                { clientIdScheme: "openid_federation" },
                "tenant",
                false,
            )
            .catch((error) => error);

        expect(error.getStatus()).toBe(400);
        expect(error.message).toContain("openid_credential_verifier");
    });

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

    it("binds a DC API session to the requested allowed origin", async () => {
        const service = createService(vi.fn().mockResolvedValue(undefined), {
            allowedOrigins: ["https://shop.example", "https://rp"],
        });

        await service.createRequest(
            "presentation",
            {},
            "tenant",
            true,
            "https://rp/checkout",
        );

        expect(
            (service as unknown as { createSession: { execute: unknown } })
                .createSession.execute,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                useDcApi: true,
                browserOrigin: "https://rp",
            }),
        );
    });

    it.each([
        [
            "without expected_origin and allowedOrigins",
            {},
            undefined,
            'Presentation config "presentation" needs expected_origin',
        ],
        [
            "for an origin it does not list",
            { allowedOrigins: ["https://rp"] },
            "https://evil.example",
            'Presentation config "presentation" does not allow the origin https://evil.example',
        ],
        [
            "without an origin while several are allowed",
            { allowedOrigins: ["https://rp", "https://shop.example"] },
            undefined,
            "set expected_origin",
        ],
    ])(
        "refuses a DC API request %s",
        async (_case, presentationConfig, origin, message) => {
            const updateForTenant = vi.fn();
            const service = createService(updateForTenant, presentationConfig);

            const error = await service
                .createRequest("presentation", {}, "tenant", true, origin)
                .catch((error) => error);

            expect(error.getStatus()).toBe(400);
            expect(error.message).toContain(message);
            expect(
                (service as unknown as { createSession: { execute: unknown } })
                    .createSession.execute,
            ).not.toHaveBeenCalled();
        },
    );

    it("binds an existing session to the allowed origin of a DC API request", async () => {
        const updateForTenant = vi.fn().mockResolvedValue(undefined);
        const service = createService(updateForTenant);

        await service.createRequest(
            "presentation",
            { session: "existing" },
            "tenant",
            true,
            "https://rp",
        );

        expect(updateForTenant).toHaveBeenCalledExactlyOnceWith(
            "tenant",
            "existing",
            expect.objectContaining({
                useDcApi: true,
                browserOrigin: "https://rp",
            }),
        );
    });

    it("binds a DC API session to any origin without allowedOrigins", async () => {
        const service = createService(vi.fn().mockResolvedValue(undefined), {});

        await service.createRequest(
            "presentation",
            {},
            "tenant",
            true,
            "https://shop.example",
        );

        expect(
            (service as unknown as { createSession: { execute: unknown } })
                .createSession.execute,
        ).toHaveBeenCalledWith(
            expect.objectContaining({ browserOrigin: "https://shop.example" }),
        );
    });

    it("ignores the origin of uri requests", async () => {
        const service = createService(vi.fn().mockResolvedValue(undefined), {});

        await service.createRequest(
            "presentation",
            {},
            "tenant",
            false,
            "https://evil.example",
        );

        expect(
            (service as unknown as { createSession: { execute: unknown } })
                .createSession.execute,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                useDcApi: false,
                browserOrigin: undefined,
            }),
        );
    });

    it("stores the access key chain of the client_id on a new session", async () => {
        const service = createService(vi.fn().mockResolvedValue(undefined));

        await service.createRequest("presentation", {}, "tenant", false);

        expect(
            (service as unknown as { createSession: { execute: unknown } })
                .createSession.execute,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                clientId: "x509_hash:hash",
                accessKeyChainId: "access-a",
            }),
        );
    });

    it("stores the access key chain of the client_id on an existing session", async () => {
        const updateForTenant = vi.fn().mockResolvedValue(undefined);
        const service = createService(updateForTenant);

        await service.createRequest(
            "presentation",
            { session: "existing" },
            "tenant",
            false,
        );

        expect(updateForTenant).toHaveBeenCalledExactlyOnceWith(
            "tenant",
            "existing",
            expect.objectContaining({
                clientId: "x509_hash:hash",
                accessKeyChainId: "access-a",
            }),
        );
    });
});

describe("OID4VP request object signing key", () => {
    function createService(
        session: Record<string, unknown>,
        presentationConfig: Record<string, unknown> = {},
    ) {
        const find = vi.fn(async ({ keyId }: { keyId?: string }) => ({
            keyId: keyId ?? "current-default",
        }));
        const getCertChain = vi.fn(({ keyId }: { keyId: string }) => [
            `cert-of-${keyId}`,
        ]);
        const signJWT = vi.fn().mockResolvedValue("signed.request.object");
        const getOrIssueRegistrationCertificate = vi
            .fn()
            .mockResolvedValue("registration.cert.jwt");
        const federationIdentity = {
            forTenant: vi.fn().mockResolvedValue({
                entityId: "https://verifier.example/issuers/tenant",
                includeTrustChain: false,
            }),
            trustChain: vi.fn().mockResolvedValue(["ec", "statement", "ta"]),
        };
        const service = Object.assign(
            Object.create(Oid4vpService.prototype) as Oid4vpService,
            {
                sessionStore: {
                    getForInternalFlow: vi.fn().mockResolvedValue({
                        id: "session",
                        tenantId: "tenant",
                        requestId: "presentation",
                        walletNonce: "nonce",
                        ...session,
                    }),
                    updateForTenant: vi.fn().mockResolvedValue(undefined),
                },
                traceService: { getSpan: () => undefined },
                auditLogger: {
                    logFlowStart: vi.fn(),
                    logFlowError: vi.fn(),
                },
                settings: {
                    publicUrl: "https://verifier.example",
                    removeTrustedAuthorities: false,
                },
                presentationConfigService: {
                    getPresentationConfig: vi.fn().mockResolvedValue({
                        dcql_query: { credentials: [] },
                        ...presentationConfig,
                    }),
                },
                trustedAuthoritiesService: {
                    transformDcqlTrustedAuthoritiesToAki: vi.fn(
                        async (query: unknown) => query,
                    ),
                },
                encryptionService: {
                    generateEphemeralEncryptionKeyPair: vi
                        .fn()
                        .mockResolvedValue({ publicJwk: {}, privateJwk: {} }),
                    getEncryptionPublicKey: vi.fn().mockResolvedValue({
                        kid: "tenant-encryption",
                        use: "enc",
                    }),
                },
                verifierMetadata: new VerifierMetadataService(
                    new CryptoImplementationService(),
                    {} as never,
                    {} as never,
                ),
                federationIdentity,
                certService: {
                    find,
                    getCertChain,
                    getCertHash: vi.fn(
                        ({ keyId }: { keyId: string }) => `hash-of-${keyId}`,
                    ),
                },
                keyChainService: { signJWT },
                registrationCertificateService: {
                    getOrIssueRegistrationCertificate,
                },
            },
        );
        return {
            service,
            find,
            signJWT,
            getOrIssueRegistrationCertificate,
            federationIdentity,
        };
    }

    const federationClientId =
        "openid_federation:https://verifier.example/issuers/tenant";

    it("signs a federation request without x5c and encrypts to the published tenant key", async () => {
        const { service, signJWT } = createService({
            clientId: federationClientId,
            accessKeyChainId: "access-a",
        });

        await service.createAuthorizationRequest("session");

        const [payload, header, , keyId] = signJWT.mock.calls[0];
        expect(payload.client_id).toBe(federationClientId);
        expect(payload.aud).toBe("https://self-issued.me/v2");
        expect(header.x5c).toBeUndefined();
        expect(header.trust_chain).toBeUndefined();
        expect(keyId).toBe("access-a");
        expect(payload.client_metadata.jwks.keys).toEqual([
            { kid: "tenant-encryption", use: "enc" },
        ]);
        const store = (
            service as unknown as {
                sessionStore: { updateForTenant: ReturnType<typeof vi.fn> };
            }
        ).sessionStore.updateForTenant;
        expect(store).not.toHaveBeenCalledWith(
            "tenant",
            "session",
            expect.objectContaining({
                responseEncryptionPrivateJwk: expect.anything(),
            }),
        );
    });

    it("adds the trust chain of the entity when configured", async () => {
        const { service, signJWT, federationIdentity } = createService({
            clientId: federationClientId,
            accessKeyChainId: "access-a",
        });
        federationIdentity.forTenant.mockResolvedValue({
            entityId: "https://verifier.example/issuers/tenant",
            includeTrustChain: true,
        });

        await service.createAuthorizationRequest("session");

        expect(signJWT.mock.calls[0][1].trust_chain).toEqual([
            "ec",
            "statement",
            "ta",
        ]);
        // Only in the JWS header: @openid4vc/openid4vp 0.7 wallets reject the
        // request parameter with an openid_federation: client_id.
        expect(signJWT.mock.calls[0][0].trust_chain).toBeUndefined();
    });

    it("refuses a federation request whose entity is no longer configured", async () => {
        const { service, signJWT, federationIdentity } = createService({
            clientId: federationClientId,
            accessKeyChainId: "access-a",
        });
        federationIdentity.forTenant.mockResolvedValue({
            entityId: "https://other.example",
            includeTrustChain: false,
        });

        await expect(
            service.createAuthorizationRequest("session"),
        ).rejects.toThrow("no longer configured");
        expect(signJWT).not.toHaveBeenCalled();
    });

    it("signs with the access key chain stored with the client_id, not the current default", async () => {
        const { service, find, signJWT } = createService({
            clientId: "x509_hash:hash-of-access-a",
            accessKeyChainId: "access-a",
        });

        await service.createAuthorizationRequest("session");

        expect(find).toHaveBeenCalledWith(
            expect.objectContaining({ keyId: "access-a" }),
        );
        const [payload, header, tenantId, keyId] = signJWT.mock.calls[0];
        expect(payload.client_id).toBe("x509_hash:hash-of-access-a");
        expect(header.x5c).toEqual(["cert-of-access-a"]);
        expect(tenantId).toBe("tenant");
        expect(keyId).toBe("access-a");
    });

    it("links the registration certificate to the access key chain stored with the client_id", async () => {
        const { service, signJWT, getOrIssueRegistrationCertificate } =
            createService(
                {
                    clientId: "x509_hash:hash-of-access-a",
                    accessKeyChainId: "access-a",
                },
                { registration_cert: { body: {} } },
            );

        await service.createAuthorizationRequest("session");

        expect(getOrIssueRegistrationCertificate).toHaveBeenCalledWith(
            expect.objectContaining({ registration_cert: { body: {} } }),
            { credentials: [] },
            "presentation",
            expect.objectContaining({ keyId: "access-a" }),
        );
        expect(signJWT.mock.calls[0][0].verifier_info).toEqual([
            expect.objectContaining({ data: "registration.cert.jwt" }),
        ]);
    });

    it("falls back to the presentation configuration's key chain for sessions without a stored one", async () => {
        const { service, signJWT } = createService(
            { clientId: "x509_hash:hash-of-configured" },
            { accessKeyChainId: "configured" },
        );

        await service.createAuthorizationRequest("session");

        expect(signJWT.mock.calls[0][3]).toBe("configured");
    });

    it("signs the origin stored on a DC API session as expected_origins", async () => {
        const { service, signJWT } = createService({
            clientId: "x509_hash:hash-of-access-a",
            accessKeyChainId: "access-a",
            useDcApi: true,
            browserOrigin: "https://shop.example",
        });

        await service.createAuthorizationRequest("session");

        const [payload] = signJWT.mock.calls[0];
        expect(payload.expected_origins).toEqual(["https://shop.example"]);
        expect(payload.response_mode).toBe("dc_api.jwt");
    });

    it("refuses to sign a DC API session without an allowed origin", async () => {
        const { service, signJWT } = createService({
            clientId: "x509_hash:hash-of-access-a",
            accessKeyChainId: "access-a",
            useDcApi: true,
        });

        await expect(
            service.createAuthorizationRequest("session"),
        ).rejects.toThrow("DC API session has no allowed origin");
        expect(signJWT).not.toHaveBeenCalled();
    });

    it("signs no expected_origins for uri sessions", async () => {
        const { service, signJWT } = createService({
            clientId: "x509_hash:hash-of-access-a",
            accessKeyChainId: "access-a",
            useDcApi: false,
            browserOrigin: "https://shop.example",
        });

        await service.createAuthorizationRequest("session");

        expect(signJWT.mock.calls[0][0].expected_origins).toBeUndefined();
    });

    it("announces the mdoc algorithms with the OID4VP 1.0 Appendix B.2.2 parameters", async () => {
        const { service, signJWT } = createService({
            clientId: "x509_hash:hash-of-access-a",
            accessKeyChainId: "access-a",
        });

        await service.createAuthorizationRequest("session");

        expect(
            signJWT.mock.calls[0][0].client_metadata.vp_formats_supported
                .mso_mdoc,
        ).toEqual({
            issuerauth_alg_values: [-7, -35, -36],
            deviceauth_alg_values: [-7, -35, -36, -9, -51, -52],
        });
    });

    it("fails instead of signing with another key chain when the stored one is gone", async () => {
        const { service, find, signJWT } = createService({
            clientId: "x509_hash:hash-of-access-a",
            accessKeyChainId: "access-a",
        });
        find.mockRejectedValueOnce(new Error("Key chain not found"));

        await expect(
            service.createAuthorizationRequest("session"),
        ).rejects.toThrow("Key chain not found");
        expect(find).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ keyId: "access-a" }),
        );
        expect(signJWT).not.toHaveBeenCalled();
    });
});
