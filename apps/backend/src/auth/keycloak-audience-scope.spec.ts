import { describe, expect, it, vi } from "vitest";
import {
    AUDIENCE_SCOPE,
    ensureAudienceScope,
} from "./keycloak-audience-scope.js";

const AUDIENCE = "https://eudiplo.example.com/api";

function keycloak({
    scope,
    mappers = [],
}: {
    scope?: { id: string };
    mappers?: { id?: string; name?: string; config?: Record<string, string> }[];
} = {}) {
    return {
        clientScopes: {
            findOneByName: vi.fn().mockResolvedValue(scope),
            create: vi.fn().mockResolvedValue({ id: "scope-new" }),
            listProtocolMappers: vi.fn().mockResolvedValue(mappers),
            addProtocolMapper: vi.fn(),
            updateProtocolMapper: vi.fn(),
        },
    };
}

const ensure = (kc: ReturnType<typeof keycloak>) =>
    ensureAudienceScope(kc as never, AUDIENCE);

describe("ensureAudienceScope", () => {
    it("creates the scope with an audience mapper for access tokens", async () => {
        const kc = keycloak();

        await expect(ensure(kc)).resolves.toBe("scope-new");

        expect(kc.clientScopes.create).toHaveBeenCalledWith(
            expect.objectContaining({
                name: AUDIENCE_SCOPE,
                protocol: "openid-connect",
                protocolMappers: [
                    expect.objectContaining({
                        protocolMapper: "oidc-audience-mapper",
                        config: expect.objectContaining({
                            "included.custom.audience": AUDIENCE,
                            "access.token.claim": "true",
                            "id.token.claim": "false",
                        }),
                    }),
                ],
            }),
        );
        // The ID comes from the create call.
        expect(kc.clientScopes.findOneByName).toHaveBeenCalledTimes(1);
    });

    it("adds the mapper to an existing scope that lacks it", async () => {
        const kc = keycloak({ scope: { id: "scope-1" } });

        await expect(ensure(kc)).resolves.toBe("scope-1");

        expect(kc.clientScopes.create).not.toHaveBeenCalled();
        expect(kc.clientScopes.addProtocolMapper).toHaveBeenCalledWith(
            { id: "scope-1" },
            expect.objectContaining({ name: AUDIENCE_SCOPE }),
        );
    });

    it("updates the mapper when OIDC_AUDIENCE changed", async () => {
        const kc = keycloak({
            scope: { id: "scope-1" },
            mappers: [
                {
                    id: "mapper-1",
                    name: AUDIENCE_SCOPE,
                    config: { "included.custom.audience": "https://old" },
                },
            ],
        });

        await expect(ensure(kc)).resolves.toBe("scope-1");

        expect(kc.clientScopes.updateProtocolMapper).toHaveBeenCalledWith(
            { id: "scope-1", mapperId: "mapper-1" },
            expect.objectContaining({
                id: "mapper-1",
                config: expect.objectContaining({
                    "included.custom.audience": AUDIENCE,
                }),
            }),
        );
    });

    it("leaves a current mapper alone and returns the scope, as on every restart", async () => {
        const kc = keycloak({
            scope: { id: "scope-1" },
            mappers: [
                {
                    id: "mapper-1",
                    name: AUDIENCE_SCOPE,
                    config: { "included.custom.audience": AUDIENCE },
                },
            ],
        });

        await expect(ensure(kc)).resolves.toBe("scope-1");

        expect(kc.clientScopes.addProtocolMapper).not.toHaveBeenCalled();
        expect(kc.clientScopes.updateProtocolMapper).not.toHaveBeenCalled();
    });
});
