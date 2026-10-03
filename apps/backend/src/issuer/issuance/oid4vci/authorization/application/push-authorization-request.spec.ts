import type { Oauth2AuthorizationServer } from "@openid4vc/oauth2";
import { describe, expect, it, vi } from "vitest";
import { PushAuthorizationRequest } from "./push-authorization-request.js";

const ISSUER = "https://issuer.example/issuers/tenant-1";

/** Built-in PAR endpoint with fake ports. */
function pushAuthorizationRequest(issuanceConfig: Record<string, unknown>) {
    const server = {
        verifyPushedAuthorizationRequest: vi.fn().mockResolvedValue({}),
    };
    const useCase = new PushAuthorizationRequest(
        {
            forTenant: () => server as unknown as Oauth2AuthorizationServer,
        },
        { updateForTenant: vi.fn().mockResolvedValue(0) },
        { execute: vi.fn().mockResolvedValue(undefined) },
        {
            issuanceConfiguration: vi.fn().mockResolvedValue(issuanceConfig),
            statusListAggregationEnabled: vi.fn().mockResolvedValue(false),
            sessionTtlSeconds: vi.fn().mockResolvedValue(3600),
        } as any,
        {
            execute: vi.fn().mockResolvedValue({
                issuer: ISSUER,
                dpop_signing_alg_values_supported: ["ES256"],
            }),
        },
        { verify: vi.fn().mockResolvedValue(undefined) },
        { register: vi.fn().mockResolvedValue(true) },
    );
    const execute = () =>
        useCase.execute({
            tenantId: "tenant-1",
            body: {
                response_type: "code",
                client_id: "wallet",
                redirect_uri: "https://wallet.example/cb",
                code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
                code_challenge_method: "S256",
            },
            request: {
                url: `${ISSUER}/authorize/par`,
                method: "POST",
                headers: new Headers(),
            },
        });
    const dpopRequired = () =>
        server.verifyPushedAuthorizationRequest.mock.calls[0][0].dpop.required;
    return { execute, dpopRequired };
}

describe("PushAuthorizationRequest DPoP", () => {
    it("keeps DPoP optional by default and with dPopRequired alone", async () => {
        for (const config of [
            { authorizationServers: [{ type: "built-in", id: "built-in" }] },
            {
                dPopRequired: true,
                authorizationServers: [{ type: "built-in", id: "built-in" }],
            },
        ]) {
            const { execute, dpopRequired } = pushAuthorizationRequest(config);
            await execute();
            expect(dpopRequired()).toBe(false);
        }
    });

    it("requires DPoP when the built-in server sets requireDPoP", async () => {
        const { execute, dpopRequired } = pushAuthorizationRequest({
            authorizationServers: [
                { type: "built-in", id: "built-in", requireDPoP: true },
            ],
        });

        await execute();

        expect(dpopRequired()).toBe(true);
    });
});
