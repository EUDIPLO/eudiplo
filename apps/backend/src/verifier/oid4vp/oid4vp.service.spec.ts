import { describe, expect, it, vi } from "vitest";
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
                        { updateForTenant: update },
                        { announce },
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
                    { updateForTenant: update },
                    { announce },
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
    function createService(redirectUri?: string) {
        const session = {
            id: "session",
            tenantId: "tenant",
            walletNonce: "expected",
            requestId: "presentation",
            consumed: false,
            redirectUri,
            responseEncryptionPrivateJwk: { kty: "oct", k: "secret" },
        };
        const update = vi.fn().mockResolvedValue(true);
        const announce = vi.fn();
        const decrypt = vi.fn().mockResolvedValue({
            error: "access_denied",
            error_description: "User declined",
            state: "expected",
        });
        const service = Object.assign(
            Object.create(Oid4vpService.prototype) as Oid4vpService,
            {
                resolveSessionByNonce: vi.fn().mockResolvedValue(session),
                logger: { debug: vi.fn() },
                traceService: { getSpan: () => undefined },
                encryptionService: { decryptJweWithPrivateJwk: decrypt },
                parseAuthorizationResponse: new ParseAuthorizationResponse(),
                auditLogger: { logFlowError: vi.fn() },
                sessionStore: { updateIfUnconsumed: update },
                changeSessionState: { announce },
            },
        );
        return { service, session, update, announce, decrypt };
    }

    it.each([
        [
            "plain",
            { error: "access_denied", error_description: "User declined" },
        ],
        ["encrypted", { response: "encrypted" }],
    ])(
        "marks the session failed and returns without an exception for a %s error response",
        async (_kind, body) => {
            const { service, session, update, announce } = createService();

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
                    outcome: {
                        result: "failed",
                        error: "access_denied",
                        message: "Wallet error: access_denied: User declined",
                    },
                    responseEncryptionPrivateJwk: null,
                },
            );
            expect(announce).toHaveBeenCalledExactlyOnceWith(session, "failed");
        },
    );

    it("returns the redirect_uri with the wallet error for an encrypted error response", async () => {
        const { service } = createService(
            "https://client.example/complete/{sessionId}",
        );

        await expect(
            service.getResponse({ response: "encrypted" }, "expected"),
        ).resolves.toEqual({
            redirect_uri:
                "https://client.example/complete/session?error=access_denied&error_description=User%20declined",
        });
    });

    it("does not overwrite a session a concurrent presentation already completed", async () => {
        const { service, update, announce } = createService();
        update.mockResolvedValue(false);

        const error = await service
            .getResponse({ error: "access_denied" }, "expected")
            .catch((error) => error);

        expect(error.getStatus()).toBe(400);
        expect(announce).not.toHaveBeenCalled();
    });
});
