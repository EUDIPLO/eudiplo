import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { describe, expect, it, vi } from "vitest";
import { ConfigImportService } from "../platform/config-import/config-import.service.js";
import { ConfigImportOrchestratorService } from "../platform/config-import/config-import-orchestrator.service.js";
import { OutboundUrlPolicyService } from "../webhook/outbound-url-policy.service.js";
import { oidcIssuerMetadataProvider } from "./auth.module.js";
import { AUTH_SETTINGS } from "./auth-settings.js";
import { authSettingsProvider } from "./auth-settings.module.js";
import { IdpManagedClientsProvider } from "./client/adapters/idp-managed-clients.service.js";
import { InternalClientsProvider } from "./client/adapters/internal-clients.service.js";
import { KeycloakClientsProvider } from "./client/adapters/keycloak-clients.service.js";
import { clientsProvider } from "./client/client.module.js";
import { CLIENTS_PROVIDER } from "./client/client.provider.js";
import { ClientEntity } from "./client/entities/client.entity.js";
import { OIDC_ISSUER_METADATA } from "./ports/oidc-issuer-metadata.js";
import { KeycloakUsersProvider } from "./user/adapters/keycloak-users.service.js";
import { UnmanagedUsersProvider } from "./user/adapters/unmanaged-users.service.js";
import { usersProvider } from "./user/user.module.js";
import {
    USERS_PROVIDER,
    UserManagementNotSupported,
} from "./user/user.provider.js";

const KEYCLOAK = "https://keycloak.example.com/realms/eudiplo";
const GENERIC = "https://auth.example.com/application/o/eudiplo/";

/**
 * The providers of the auth modules for the given environment, compiled but
 * not started, so no adapter connects anywhere.
 */
async function wiringFor(env: Record<string, string>) {
    const outbound = {
        get: vi.fn(async () => ({
            status: 200,
            body: JSON.stringify({
                issuer: GENERIC,
                jwks_uri: `${GENERIC}jwks/`,
                token_endpoint: "https://auth.example.com/application/o/token/",
            }),
        })),
    };
    const orchestrator = { register: vi.fn() };
    const moduleRef = await Test.createTestingModule({
        providers: [
            {
                // Only these values, not the environment of the test run.
                provide: ConfigService,
                useValue: {
                    get: (key: string) => env[key],
                    getOrThrow: (key: string) => env[key],
                },
            },
            authSettingsProvider,
            { provide: OutboundUrlPolicyService, useValue: outbound },
            { provide: getRepositoryToken(ClientEntity), useValue: {} },
            { provide: ConfigImportService, useValue: {} },
            {
                provide: ConfigImportOrchestratorService,
                useValue: orchestrator,
            },
            oidcIssuerMetadataProvider,
            clientsProvider,
            usersProvider,
        ],
    }).compile();
    return {
        settings: moduleRef.get(AUTH_SETTINGS),
        issuerMetadata: moduleRef.get(OIDC_ISSUER_METADATA),
        clients: moduleRef.get(CLIENTS_PROVIDER),
        users: moduleRef.get(USERS_PROVIDER),
        outbound,
        orchestrator,
    };
}

describe("Auth module wiring", () => {
    it("uses the built-in server without OIDC", async () => {
        const wiring = await wiringFor({});

        expect(wiring.settings).toEqual({ mode: "builtin" });
        expect(wiring.clients).toBeInstanceOf(InternalClientsProvider);
        expect(wiring.users).toBeInstanceOf(UnmanagedUsersProvider);
        expect(() => wiring.users.getUsers("acme")).toThrow(
            new UserManagementNotSupported("builtin"),
        );
        expect(wiring.issuerMetadata).toBeNull();
        expect(wiring.outbound.get).not.toHaveBeenCalled();
        expect(wiring.orchestrator.register).toHaveBeenCalledWith(
            "clients",
            expect.anything(),
            expect.any(Function),
        );
    });

    it("uses Keycloak with OIDC and no OIDC_PROVIDER, as before", async () => {
        const wiring = await wiringFor({
            OIDC: KEYCLOAK,
            OIDC_CLIENT_ID: "eudiplo-admin",
            OIDC_CLIENT_SECRET: "secret",
        });

        expect(wiring.settings).toMatchObject({
            mode: "keycloak",
            issuer: KEYCLOAK,
            internalIssuer: KEYCLOAK,
        });
        expect(wiring.clients).toBeInstanceOf(KeycloakClientsProvider);
        expect(wiring.users).toBeInstanceOf(KeycloakUsersProvider);
        expect(wiring.issuerMetadata).toBeNull();
        expect(wiring.outbound.get).not.toHaveBeenCalled();
    });

    it("leaves clients and people to another provider and loads its discovery document", async () => {
        const wiring = await wiringFor({
            OIDC: GENERIC,
            OIDC_PROVIDER: "generic",
            OIDC_AUDIENCE: "eudiplo-api",
        });

        expect(wiring.settings).toMatchObject({
            mode: "generic",
            issuer: GENERIC,
        });
        expect(wiring.clients).toBeInstanceOf(IdpManagedClientsProvider);
        expect(wiring.users).toBeInstanceOf(UnmanagedUsersProvider);
        expect(() => wiring.users.getUsers("acme")).toThrow(
            new UserManagementNotSupported("generic"),
        );
        expect(wiring.issuerMetadata).toEqual({
            issuer: GENERIC,
            jwks_uri: `${GENERIC}jwks/`,
            token_endpoint: "https://auth.example.com/application/o/token/",
        });
        expect(wiring.outbound.get).toHaveBeenCalledWith(
            `${GENERIC}.well-known/openid-configuration`,
            expect.objectContaining({
                trustedOrigins: ["https://auth.example.com"],
            }),
        );
    });
});
