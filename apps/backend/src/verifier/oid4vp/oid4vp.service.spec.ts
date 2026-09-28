import { describe, expect, it, vi } from "vitest";
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
                    presentationsService: {
                        getPresentationConfig: vi.fn().mockResolvedValue({}),
                        parseResponse: vi.fn().mockResolvedValue([]),
                    },
                    resolveWebhookFromEndpoint: vi
                        .fn()
                        .mockResolvedValue(undefined),
                    auditLogger: {
                        logFlowStart: vi.fn(),
                        logCredentialVerification: vi.fn(),
                        logFlowError,
                    },
                    updateSessionForTenant: { execute: update },
                    processVerifiedPresentation:
                        new ProcessVerifiedPresentation(
                            new ParseAuthorizationResponse(),
                            { execute: complete },
                            { publish },
                        ),
                    failPresentationResponse: new FailPresentationResponse({
                        execute: update,
                    }),
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
