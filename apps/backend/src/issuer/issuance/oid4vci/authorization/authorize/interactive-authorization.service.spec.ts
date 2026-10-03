import { describe, expect, it, vi } from "vitest";
import type { Oid4vciRequestContext } from "../../request-context.js";
import type { InteractiveAuthSession } from "../domain/interactive-auth-session.js";
import type { InteractiveAuthorizationRequestDto } from "./dto/interactive-authorization.dto.js";
import { InteractiveAuthorizationService } from "./interactive-authorization.service.js";

const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function interactiveAuthorization(
    storedSession?: Partial<InteractiveAuthSession>,
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
    const service = new InteractiveAuthorizationService(
        { publicUrl: "https://issuer.example" } as any,
        {} as any,
        {} as any,
        { updateForTenant: vi.fn() } as any,
        {} as any,
        {} as any,
        {} as any,
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
    return { handle, authSessionRepository };
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
});
