import { describe, expect, it, vi } from "vitest";
import { SessionNotFound } from "../../../../../session/application/session-errors.js";
import type { Oid4vciRequestContext } from "../../request-context.js";
import type { InteractiveAuthSession } from "../domain/interactive-auth-session.js";
import type { InteractiveAuthorizationRequestDto } from "./dto/interactive-authorization.dto.js";
import { InteractiveAuthorizationService } from "./interactive-authorization.service.js";

const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function interactiveAuthorization(
    storedSession?: Partial<InteractiveAuthSession>,
    ports: {
        sessionStore?: Record<string, unknown>;
        oid4vpService?: Record<string, unknown>;
    } = {},
) {
    const authSessionRepository = {
        create: vi.fn().mockResolvedValue(undefined),
        findForTenant: vi.fn().mockResolvedValue(
            storedSession && {
                id: "id-1",
                authSession: "auth-session",
                tenantId: "tenant-1",
                clientId: "wallet",
                interactionTypesSupported: "redirect_to_web",
                currentStepIndex: 0,
                status: "web_auth_completed",
                expiresAt: new Date(Date.now() + 60_000),
                createdAt: new Date(),
                updatedAt: new Date(),
                ...storedSession,
            },
        ),
        update: vi.fn().mockResolvedValue(undefined),
        updateForTenant: vi.fn().mockResolvedValue(true),
        delete: vi.fn(),
    };
    const sessionStore = { updateForTenant: vi.fn(), ...ports.sessionStore };
    const service = new InteractiveAuthorizationService(
        { publicUrl: "https://issuer.example" } as any,
        {} as any,
        {} as any,
        sessionStore as any,
        {} as any,
        {} as any,
        (ports.oid4vpService ?? {}) as any,
        {} as any,
        authSessionRepository,
    );
    const handle = (body: InteractiveAuthorizationRequestDto) =>
        service.handleRequest(
            body,
            { headers: {} } as unknown as Oid4vciRequestContext,
            "tenant-1",
            "https://issuer.example",
        );
    return { handle, service, authSessionRepository, sessionStore };
}

const initialRequest = {
    response_type: "code",
    client_id: "wallet",
    interaction_types_supported: "redirect_to_web",
} as InteractiveAuthorizationRequestDto;

describe("InteractiveAuthorizationService PKCE", () => {
    it("accepts an S256 challenge", async () => {
        const { handle, authSessionRepository } = interactiveAuthorization();

        const response = await handle({
            ...initialRequest,
            code_challenge: CODE_CHALLENGE,
            code_challenge_method: "S256",
        } as InteractiveAuthorizationRequestDto);

        expect(response).toMatchObject({
            status: "require_interaction",
            type: "redirect_to_web",
        });
        expect(authSessionRepository.create).toHaveBeenCalledWith(
            expect.objectContaining({
                codeChallenge: CODE_CHALLENGE,
                codeChallengeMethod: "S256",
            }),
        );
    });

    it("rejects plain and a challenge without method in the initial request", async () => {
        for (const method of ["plain", undefined]) {
            const { handle, authSessionRepository } =
                interactiveAuthorization();

            const response = await handle({
                ...initialRequest,
                code_challenge: CODE_CHALLENGE,
                code_challenge_method: method,
            } as InteractiveAuthorizationRequestDto);

            expect(response).toEqual({
                error: "invalid_request",
                error_description:
                    "Only code_challenge_method 'S256' is supported",
            });
            expect(authSessionRepository.create).not.toHaveBeenCalled();
        }
    });

    it("issues the code for a matching S256 verifier", async () => {
        const { handle } = interactiveAuthorization({
            codeChallenge: CODE_CHALLENGE,
            codeChallengeMethod: "S256",
        });

        await expect(
            handle({
                auth_session: "auth-session",
                code_verifier: CODE_VERIFIER,
            } as InteractiveAuthorizationRequestDto),
        ).resolves.toMatchObject({ status: "ok" });
    });

    it("rejects verifiers for sessions without an S256 challenge", async () => {
        for (const codeChallengeMethod of ["plain", undefined]) {
            const { handle } = interactiveAuthorization({
                codeChallenge: CODE_VERIFIER,
                codeChallengeMethod,
            });

            await expect(
                handle({
                    auth_session: "auth-session",
                    code_verifier: CODE_VERIFIER,
                } as InteractiveAuthorizationRequestDto),
            ).resolves.toEqual({
                error: "invalid_grant",
                error_description: "Invalid code_verifier",
            });
        }
    });

    it("rejects an initial request without code_challenge", async () => {
        const { handle, authSessionRepository } = interactiveAuthorization();

        await expect(
            handle({
                ...initialRequest,
                interaction_types_supported: "openid4vp_presentation",
            } as InteractiveAuthorizationRequestDto),
        ).resolves.toEqual({
            error: "invalid_request",
            error_description: "Missing required parameter: code_challenge",
        });
        expect(authSessionRepository.create).not.toHaveBeenCalled();
    });

    it("binds the issued code to the PKCE challenge and expires it like PAR codes", async () => {
        const { handle, sessionStore } = interactiveAuthorization({
            codeChallenge: CODE_CHALLENGE,
            codeChallengeMethod: "S256",
            issuerState: "offer-1",
        });

        await handle({
            auth_session: "auth-session",
            code_verifier: CODE_VERIFIER,
        } as InteractiveAuthorizationRequestDto);

        expect(sessionStore.updateForTenant).toHaveBeenCalledWith(
            "tenant-1",
            "offer-1",
            {
                authorization_code: expect.any(String),
                authorization_code_expires_at: expect.any(Date),
                auth_queries: {
                    code_challenge: CODE_CHALLENGE,
                    code_challenge_method: "S256",
                },
            },
        );
        const [, , update] = sessionStore.updateForTenant.mock.calls[0];
        expect(
            update.authorization_code_expires_at.getTime() - Date.now(),
        ).toBeLessThanOrEqual(60_000);
    });
});

describe("InteractiveAuthorizationService openid4vp_presentation step", () => {
    const presentationStep = {
        interactionTypesSupported: "openid4vp_presentation,redirect_to_web",
        status: "pending",
        codeChallenge: CODE_CHALLENGE,
        codeChallengeMethod: "S256",
        issuerState: "offer-1",
    };
    const presentationResponse = (openid4vp_response: string) =>
        ({
            auth_session: "auth-session",
            openid4vp_response,
        }) as InteractiveAuthorizationRequestDto;

    /** Verifier session states returned one after another. */
    function presentation(...states: Array<Record<string, unknown> | Error>) {
        const getForTenant = vi.fn();
        for (const state of states) {
            if (state instanceof Error)
                getForTenant.mockRejectedValueOnce(state);
            else
                getForTenant.mockResolvedValueOnce({
                    id: "auth-session",
                    walletNonce: "wallet-nonce",
                    ...state,
                });
        }
        return getForTenant;
    }

    it("is not completed by a code_verifier", async () => {
        const { handle } = interactiveAuthorization(presentationStep);

        await expect(
            handle({
                auth_session: "auth-session",
                code_verifier: CODE_VERIFIER,
            } as InteractiveAuthorizationRequestDto),
        ).resolves.toMatchObject({ error: "invalid_request" });
    });

    it("does not let an openid4vp_response complete a redirect_to_web step", async () => {
        const getResponse = vi.fn();
        const { handle } = interactiveAuthorization(
            { status: "pending" },
            { oid4vpService: { getResponse } },
        );

        await expect(
            handle(presentationResponse('{"response":"jwe"}')),
        ).resolves.toMatchObject({ error: "invalid_request" });
        expect(getResponse).not.toHaveBeenCalled();
    });

    it.each(["not-json", '["response"]', '{"response":1}'])(
        "rejects the malformed openid4vp_response %s",
        async (value) => {
            const { handle } = interactiveAuthorization(presentationStep);

            await expect(handle(presentationResponse(value))).resolves.toEqual({
                error: "invalid_request",
                error_description: "Invalid openid4vp_response format",
            });
        },
    );

    it("rejects a step without a presentation request", async () => {
        const { handle } = interactiveAuthorization(presentationStep, {
            sessionStore: {
                getForTenant: presentation(new SessionNotFound()),
            },
        });

        await expect(
            handle(presentationResponse('{"response":"jwe"}')),
        ).resolves.toMatchObject({ error: "invalid_request" });
    });

    it("rejects a presentation that fails verification", async () => {
        const getResponse = vi
            .fn()
            .mockRejectedValue(new Error("Invalid nonce"));
        const { handle, authSessionRepository, sessionStore } =
            interactiveAuthorization(presentationStep, {
                sessionStore: {
                    getForTenant: presentation(
                        { status: "fetched" },
                        { status: "failed" },
                    ),
                },
                oid4vpService: { getResponse },
            });

        await expect(
            handle(presentationResponse('{"response":"jwe"}')),
        ).resolves.toEqual({
            error: "access_denied",
            error_description: "The presentation could not be verified",
        });
        expect(getResponse).toHaveBeenCalledWith(
            { response: "jwe" },
            "wallet-nonce",
        );
        expect(authSessionRepository.update).not.toHaveBeenCalled();
        expect(sessionStore.updateForTenant).not.toHaveBeenCalled();
    });

    it("completes the step with a verified presentation and forwards its credentials", async () => {
        const credentials = [{ id: "pid", values: [{ given_name: "Erika" }] }];
        const getResponse = vi.fn().mockResolvedValue({});
        const { handle, sessionStore } = interactiveAuthorization(
            presentationStep,
            {
                sessionStore: {
                    getForTenant: presentation(
                        { status: "fetched" },
                        { status: "completed", credentials },
                    ),
                },
                oid4vpService: { getResponse },
            },
        );

        await expect(
            handle(presentationResponse('{"response":"jwe","extra":1}')),
        ).resolves.toMatchObject({ status: "ok", code: expect.any(String) });
        expect(getResponse).toHaveBeenCalledWith(
            { response: "jwe" },
            "wallet-nonce",
        );
        expect(sessionStore.updateForTenant).toHaveBeenCalledWith(
            "tenant-1",
            "offer-1",
            { credentials },
        );
    });

    it("accepts a presentation the wallet already posted to the response_uri", async () => {
        const getResponse = vi.fn();
        const { handle } = interactiveAuthorization(presentationStep, {
            sessionStore: {
                getForTenant: presentation(
                    { status: "completed" },
                    { status: "completed" },
                ),
            },
            oid4vpService: { getResponse },
        });

        await expect(
            handle(presentationResponse('{"response":"jwe"}')),
        ).resolves.toMatchObject({ status: "ok" });
        expect(getResponse).not.toHaveBeenCalled();
    });
});

describe("InteractiveAuthorizationService completeWebAuthorization", () => {
    it("completes the redirect_to_web step of an unexpired auth session", async () => {
        const { service, authSessionRepository } = interactiveAuthorization({
            status: "pending",
        });

        await expect(
            service.completeWebAuthorization("auth-session", "tenant-1"),
        ).resolves.toBe(true);
        expect(authSessionRepository.updateForTenant).toHaveBeenCalledWith(
            "tenant-1",
            "auth-session",
            { status: "web_auth_completed" },
        );
    });

    it.each([
        [
            "an openid4vp_presentation step",
            { interactionTypesSupported: "openid4vp_presentation" },
        ],
        ["an expired auth session", { expiresAt: new Date(Date.now() - 1) }],
    ])("does not complete %s", async (_, storedSession) => {
        const { service, authSessionRepository } = interactiveAuthorization({
            status: "pending",
            ...storedSession,
        });

        await expect(
            service.completeWebAuthorization("auth-session", "tenant-1"),
        ).resolves.toBe(false);
        expect(authSessionRepository.updateForTenant).not.toHaveBeenCalled();
    });

    it("does not complete an unknown auth session", async () => {
        const { service } = interactiveAuthorization();

        await expect(
            service.completeWebAuthorization("auth-session", "tenant-1"),
        ).resolves.toBe(false);
    });
});
