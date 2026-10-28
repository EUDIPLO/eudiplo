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
        createSession?: Record<string, unknown>;
        presentationConfigService?: Record<string, unknown>;
        credentialsService?: Record<string, unknown>;
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
        (ports.createSession ?? {}) as any,
        sessionStore as any,
        {} as any,
        (ports.credentialsService ?? {}) as any,
        (ports.oid4vpService ?? {}) as any,
        (ports.presentationConfigService ?? {}) as any,
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
        presentationSessionId: "presentation-1",
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
                    id: "presentation-1",
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

    it("creates the presentation request under its own session ID, not the auth_session", async () => {
        const execute = vi.fn().mockResolvedValue(undefined);
        const createRequest = vi.fn().mockResolvedValue({ uri: "request" });
        const { handle, authSessionRepository } = interactiveAuthorization(
            undefined,
            {
                createSession: { execute },
                oid4vpService: { createRequest },
                presentationConfigService: {
                    getPresentationConfigs: vi
                        .fn()
                        .mockResolvedValue([{ id: "pid" }]),
                },
            },
        );

        const response = await handle({
            ...initialRequest,
            interaction_types_supported: "openid4vp_presentation",
            code_challenge: CODE_CHALLENGE,
            code_challenge_method: "S256",
        } as InteractiveAuthorizationRequestDto);

        expect(response).toMatchObject({
            status: "require_interaction",
            type: "openid4vp_presentation",
        });
        const authSession = (response as { auth_session: string }).auth_session;
        const [{ id: presentationSessionId }] = execute.mock.calls[0];
        expect(presentationSessionId).not.toBe(authSession);
        expect(authSessionRepository.updateForTenant).toHaveBeenCalledWith(
            "tenant-1",
            authSession,
            { presentationSessionId },
        );
        expect(createRequest).toHaveBeenCalledWith(
            "pid",
            { session: presentationSessionId },
            "tenant-1",
            false,
            "https://issuer.example",
        );
    });

    it("creates no presentation request for an auth session that is gone", async () => {
        const execute = vi.fn();
        const createRequest = vi.fn();
        const { handle, authSessionRepository } = interactiveAuthorization(
            undefined,
            {
                createSession: { execute },
                oid4vpService: { createRequest },
                presentationConfigService: {
                    getPresentationConfigs: vi
                        .fn()
                        .mockResolvedValue([{ id: "pid" }]),
                },
            },
        );
        authSessionRepository.updateForTenant.mockResolvedValue(false);

        await expect(
            handle({
                ...initialRequest,
                interaction_types_supported: "openid4vp_presentation",
                code_challenge: CODE_CHALLENGE,
                code_challenge_method: "S256",
            } as InteractiveAuthorizationRequestDto),
        ).resolves.toEqual({
            error: "invalid_request",
            error_description: "Invalid or expired auth_session",
        });
        expect(execute).not.toHaveBeenCalled();
        expect(createRequest).not.toHaveBeenCalled();
    });

    it("looks up the step's verifier session by its own ID", async () => {
        const getForTenant = presentation(
            { status: "completed" },
            { status: "completed" },
        );
        const { handle } = interactiveAuthorization(presentationStep, {
            sessionStore: { getForTenant },
            oid4vpService: { getResponse: vi.fn() },
        });

        await handle(presentationResponse('{"response":"jwe"}'));

        expect(getForTenant).toHaveBeenCalledWith("tenant-1", "presentation-1");
        expect(getForTenant).not.toHaveBeenCalledWith(
            "tenant-1",
            "auth-session",
        );
    });

    it("does not let a verified presentation count for a later step", async () => {
        const { handle, authSessionRepository } = interactiveAuthorization(
            presentationStep,
            {
                sessionStore: {
                    getForTenant: presentation(
                        { status: "completed" },
                        { status: "completed" },
                    ),
                },
                oid4vpService: { getResponse: vi.fn() },
            },
        );

        await handle(presentationResponse('{"response":"jwe"}'));

        expect(authSessionRepository.update).toHaveBeenCalledWith(
            "id-1",
            expect.objectContaining({ presentationSessionId: null }),
        );
    });

    it("gives a second presentation step a new verifier session", async () => {
        const execute = vi.fn().mockResolvedValue(undefined);
        const createRequest = vi.fn().mockResolvedValue({ uri: "request" });
        const { handle, authSessionRepository } = interactiveAuthorization(
            {
                ...presentationStep,
                iaeActions: JSON.stringify([
                    {
                        type: "openid4vp_presentation",
                        presentationConfigId: "pid",
                    },
                    {
                        type: "openid4vp_presentation",
                        presentationConfigId: "address",
                    },
                ]),
            },
            {
                sessionStore: {
                    getForTenant: presentation(
                        { status: "completed" },
                        { status: "completed" },
                    ),
                },
                oid4vpService: { getResponse: vi.fn(), createRequest },
                createSession: { execute },
            },
        );

        await expect(
            handle(presentationResponse('{"response":"jwe"}')),
        ).resolves.toMatchObject({
            status: "require_interaction",
            type: "openid4vp_presentation",
        });
        const [{ id: nextPresentationSessionId }] = execute.mock.calls[0];
        expect(nextPresentationSessionId).not.toBe("presentation-1");
        expect(nextPresentationSessionId).not.toBe("auth-session");
        expect(authSessionRepository.updateForTenant).toHaveBeenCalledWith(
            "tenant-1",
            "auth-session",
            { presentationSessionId: nextPresentationSessionId },
        );
        expect(createRequest).toHaveBeenCalledWith(
            "address",
            { session: nextPresentationSessionId },
            "tenant-1",
            false,
            "https://issuer.example",
        );
    });

    it("rejects a step whose presentation request was never created", async () => {
        const getForTenant = vi.fn();
        const { handle } = interactiveAuthorization(
            { ...presentationStep, presentationSessionId: undefined },
            { sessionStore: { getForTenant } },
        );

        await expect(
            handle(presentationResponse('{"response":"jwe"}')),
        ).resolves.toMatchObject({ error: "invalid_request" });
        expect(getForTenant).not.toHaveBeenCalled();
    });

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

describe("InteractiveAuthorizationService redirect_to_web step", () => {
    const pkceRequest = {
        ...initialRequest,
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
    } as InteractiveAuthorizationRequestDto;

    it("stores the request_uri before returning it", async () => {
        const { handle, authSessionRepository } = interactiveAuthorization();
        let storeRequestUri!: () => void;
        authSessionRepository.updateForTenant.mockReturnValue(
            new Promise((resolve) => {
                storeRequestUri = () => resolve(true);
            }),
        );

        let returned = false;
        const pending = handle(pkceRequest).then((response) => {
            returned = true;
            return response;
        });
        await vi.waitFor(() =>
            expect(authSessionRepository.updateForTenant).toHaveBeenCalled(),
        );
        expect(returned).toBe(false);

        storeRequestUri();
        const response = await pending;
        const [, , update] =
            authSessionRepository.updateForTenant.mock.calls[0];
        expect(response).toMatchObject({ request_uri: update.requestUri });
    });

    it("returns a server_error instead of a request_uri that was not stored", async () => {
        const { handle, authSessionRepository } = interactiveAuthorization();
        authSessionRepository.updateForTenant.mockRejectedValue(
            new Error("database unavailable"),
        );

        const response = await handle(pkceRequest);

        expect(response).toMatchObject({ error: "server_error" });
        expect(response).not.toHaveProperty("request_uri");
    });

    it("fails a configured redirect_to_web action whose request_uri cannot be stored", async () => {
        const getCredentialConfig = vi.fn().mockResolvedValue({
            iaeActions: [
                { type: "redirect_to_web", url: "https://login.example" },
            ],
        });
        const { handle, authSessionRepository } = interactiveAuthorization(
            undefined,
            { credentialsService: { getCredentialConfig } },
        );
        authSessionRepository.updateForTenant.mockRejectedValue(
            new Error("database unavailable"),
        );

        const response = await handle({
            ...pkceRequest,
            authorization_details: [
                {
                    type: "openid_credential",
                    credential_configuration_id: "pid",
                },
            ],
        } as InteractiveAuthorizationRequestDto);

        expect(getCredentialConfig).toHaveBeenCalledWith("pid", "tenant-1");
        expect(response).toMatchObject({ error: "server_error" });
        expect(response).not.toHaveProperty("request_uri");
    });

    it("returns no request_uri when the auth session is gone", async () => {
        const { handle, authSessionRepository } = interactiveAuthorization();
        authSessionRepository.updateForTenant.mockResolvedValue(false);

        const response = await handle(pkceRequest);

        expect(response).toEqual({
            error: "invalid_request",
            error_description: "Invalid or expired auth_session",
        });
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
