import type { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";
import { AuthService } from "./auth.service.js";
import { readAuthSettings } from "./auth-settings.js";
import type { OidcIssuerMetadata } from "./ports/oidc-issuer-metadata.js";

const PUBLIC_URL = "https://eudiplo.example.com";

function serviceFor(
    values: Record<string, string>,
    issuerMetadata: OidcIssuerMetadata | null = null,
) {
    const config = {
        get: (key: string) => values[key],
        getOrThrow: (key: string) => values[key],
    } as unknown as ConfigService;
    return new AuthService(
        {} as never,
        {} as never,
        config,
        readAuthSettings(config),
        issuerMetadata,
    );
}

describe("AuthService discovery", () => {
    it("advertises the built-in token endpoint without single sign-on", () => {
        const discovery = serviceFor({ PUBLIC_URL }).getOidcDiscovery();

        expect(discovery).toMatchObject({
            issuer: PUBLIC_URL,
            token_endpoint: `${PUBLIC_URL}/api/oauth2/token`,
            jwks_uri: `${PUBLIC_URL}/.well-known/jwks.json`,
        });
        expect(discovery).not.toHaveProperty("ui_client_id");
    });

    it("advertises Keycloak's token endpoint and the Web Client's client", () => {
        const oidc = "https://keycloak.example.com/realms/eudiplo";

        expect(
            serviceFor({
                PUBLIC_URL,
                OIDC: oidc,
                OIDC_UI_CLIENT_ID: "web-ui",
            }).getOidcDiscovery(),
        ).toMatchObject({
            issuer: oidc,
            token_endpoint: `${oidc}/protocol/openid-connect/token`,
            jwks_uri: `${PUBLIC_URL}/.well-known/jwks.json`,
            ui_client_id: "web-ui",
            oidc_provider: "keycloak",
        });
    });

    it("advertises another provider's endpoints and the Web Client's client there", () => {
        const issuer = "https://auth.example.com/application/o/eudiplo/";
        const discovery = serviceFor(
            {
                PUBLIC_URL,
                OIDC: issuer,
                OIDC_PROVIDER: "generic",
                OIDC_UI_CLIENT_ID: "eudiplo-console",
            },
            {
                issuer,
                jwks_uri: `${issuer}jwks/`,
                token_endpoint: "https://auth.example.com/application/o/token/",
            },
        ).getOidcDiscovery();

        expect(discovery).toMatchObject({
            issuer,
            token_endpoint: "https://auth.example.com/application/o/token/",
            jwks_uri: `${issuer}jwks/`,
            ui_client_id: "eudiplo-console",
            oidc_provider: "generic",
        });
    });

    it("never falls back to Keycloak's endpoints for another provider", () => {
        expect(() =>
            serviceFor({
                PUBLIC_URL,
                OIDC: "https://auth.example.com/",
                OIDC_PROVIDER: "generic",
            }).getOidcDiscovery(),
        ).toThrow("The OIDC discovery document was not loaded");
    });
});

describe("AuthService token endpoint", () => {
    it.each([
        ["Keycloak", {}],
        ["another provider", { OIDC_PROVIDER: "generic" }],
    ])("is not available with %s", async (_, values) => {
        await expect(
            serviceFor({
                PUBLIC_URL,
                OIDC: "https://auth.example.com/",
                ...values,
            }).getOAuth2Token({}, {}),
        ).rejects.toThrow(
            "OAuth2 token endpoint is not available when using external OIDC provider",
        );
    });
});
