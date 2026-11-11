import { UnauthorizedException } from "@nestjs/common";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { readAuthSettings } from "./auth-settings.js";
import { IdpManagedClientsProvider } from "./client/adapters/idp-managed-clients.service.js";
import type { ClientData } from "./client/domain/client-data.js";
import { externalTokenChecks, JwtStrategy } from "./jwt.strategy.js";
import type { OidcIssuerMetadata } from "./ports/oidc-issuer-metadata.js";
import { Role } from "./roles/role.enum.js";
import { TenantNotFound } from "./tenant/domain/tenant-data.js";
import type { InternalTokenPayload } from "./token.decorator.js";

const DAY = 24 * 60 * 60;
const NOW = 1_800_000_000;

function configService(values: Record<string, string>) {
    return {
        get: (key: string) => values[key],
        getOrThrow: (key: string) => {
            if (values[key] === undefined) throw new Error(`${key} missing`);
            return values[key];
        },
    } as never;
}

describe("JwtStrategy", () => {
    /** A strategy for these settings, as AuthModule builds it. */
    function strategyFor(
        values: Record<string, string>,
        issuerMetadata: OidcIssuerMetadata | null,
        clients: object = clientsProvider,
    ) {
        return new JwtStrategy(
            configService(values),
            tenantService as never,
            clients as never,
            readAuthSettings(configService(values)),
            issuerMetadata,
            {} as never,
        );
    }

    let clients: Map<string, ClientData>;
    let tenantService: { getTenant: ReturnType<typeof vi.fn> };
    let clientsProvider: { getClientById: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        clients = new Map();
        tenantService = {
            getTenant: vi.fn(async (id: string) => ({ id, name: id })),
        };
        clientsProvider = {
            getClientById: vi.fn(async (id: string) => clients.get(id) ?? null),
        };
    });

    describe("built-in OAuth2 server", () => {
        let strategy: JwtStrategy;

        beforeEach(() => {
            strategy = strategyFor({ MASTER_SECRET: "x".repeat(32) }, null);
        });

        function token(
            claims: Partial<InternalTokenPayload>,
            lifetime = DAY,
        ): InternalTokenPayload {
            return {
                tenant_id: "acme",
                sub: "shop",
                roles: [Role.IssuanceOffer],
                iat: NOW,
                exp: NOW + lifetime,
                ...claims,
            };
        }

        test("takes roles and limits from the stored client", async () => {
            clients.set("shop", {
                clientId: "shop",
                tenantId: "acme",
                roles: [Role.PresentationRequest],
                allowedPresentationConfigs: ["age"],
            });

            const user = await strategy.validate(
                token({ roles: [Role.IssuanceOffer, Role.Clients] }),
            );

            expect(user.roles).toEqual([Role.PresentationRequest]);
            expect(user.client?.allowedPresentationConfigs).toEqual(["age"]);
            expect(user.entity?.id).toBe("acme");
            expect(user.subject).toBe("shop");
        });

        test("rejects the token of a deleted client", async () => {
            await expect(strategy.validate(token({}))).rejects.toThrow(
                UnauthorizedException,
            );
        });

        test("rejects a token for another tenant than the client's", async () => {
            clients.set("shop", {
                clientId: "shop",
                tenantId: "other",
                roles: [Role.IssuanceOffer],
            });

            await expect(strategy.validate(token({}))).rejects.toThrow(
                UnauthorizedException,
            );
        });

        test("accepts a token naming the client's current credentials", async () => {
            const credentialsAt = new Date(NOW * 1000 + 900);
            clients.set("shop", {
                clientId: "shop",
                tenantId: "acme",
                roles: [Role.IssuanceOffer],
                tokensValidAfter: credentialsAt,
            });

            await expect(
                strategy.validate(
                    token({ credentials_at: credentialsAt.getTime() }),
                ),
            ).resolves.toBeDefined();
        });

        test("rejects a token naming earlier or no credentials", async () => {
            clients.set("shop", {
                clientId: "shop",
                tenantId: "acme",
                roles: [Role.IssuanceOffer],
                tokensValidAfter: new Date(NOW * 1000 + 900),
            });

            // Also when issued after the change: the secret was read before.
            await expect(
                strategy.validate(
                    token({ iat: NOW + 1, credentials_at: NOW * 1000 }),
                ),
            ).rejects.toThrow(UnauthorizedException);
            await expect(strategy.validate(token({}))).rejects.toThrow(
                UnauthorizedException,
            );
        });

        test("accepts any token of a client without tokensValidAfter", async () => {
            clients.set("shop", {
                clientId: "shop",
                tenantId: "acme",
                roles: [Role.IssuanceOffer],
                tokensValidAfter: null,
            });

            await expect(strategy.validate(token({}))).resolves.toBeDefined();
        });

        test("accepts the root client, which has no tenant", async () => {
            clients.set("root", {
                clientId: "root",
                tenantId: null,
                roles: [Role.Tenants],
            });

            const user = await strategy.validate(
                token({ sub: "root", tenant_id: null as never }),
            );

            expect(user.roles).toEqual([Role.Tenants]);
            expect(user.entity).toBeUndefined();
            expect(tenantService.getTenant).not.toHaveBeenCalled();
        });

        test("accepts an access token of 9.x that spans a second more", async () => {
            clients.set("shop", {
                clientId: "shop",
                tenantId: "acme",
                roles: [Role.IssuanceOffer],
            });

            const user = await strategy.validate(token({}, DAY + 1));

            expect(user.client?.clientId).toBe("shop");
            await expect(
                strategy.validate(token({}, DAY + 60)),
            ).resolves.toBeDefined();
            await expect(
                strategy.validate(token({}, DAY + 61)),
            ).rejects.toThrow(UnauthorizedException);
        });

        test("rejects a token that lives longer than an access token", async () => {
            clients.set("shop", {
                clientId: "shop",
                tenantId: "acme",
                roles: [Role.IssuanceOffer],
            });

            await expect(
                strategy.validate(token({}, 30 * DAY)),
            ).rejects.toThrow(UnauthorizedException);
            for (const claims of [{ iat: undefined }, { exp: undefined }]) {
                await expect(strategy.validate(token(claims))).rejects.toThrow(
                    UnauthorizedException,
                );
            }
            expect(clientsProvider.getClientById).not.toHaveBeenCalled();
        });

        test("rejects a token without a subject", async () => {
            clients.set("shop", {
                clientId: "shop",
                tenantId: "acme",
                roles: [Role.IssuanceOffer],
            });

            await expect(
                strategy.validate(token({ sub: undefined })),
            ).rejects.toThrow(UnauthorizedException);
            expect(clientsProvider.getClientById).not.toHaveBeenCalled();
        });

        test("fails when the client or tenant lookup fails", async () => {
            clients.set("shop", {
                clientId: "shop",
                tenantId: "acme",
                roles: [Role.IssuanceOffer],
            });
            clientsProvider.getClientById.mockRejectedValueOnce(
                new Error("db down"),
            );
            await expect(strategy.validate(token({}))).rejects.toThrow(
                "db down",
            );

            tenantService.getTenant.mockRejectedValueOnce(new Error("db down"));
            await expect(strategy.validate(token({}))).rejects.toThrow(
                "db down",
            );
        });
    });

    describe("Keycloak", () => {
        let strategy: JwtStrategy;

        beforeEach(() => {
            strategy = strategyFor(
                {
                    OIDC: "https://keycloak.example.com/realms/eudiplo",
                    OIDC_INTERNAL_ISSUER_URL:
                        "https://keycloak.example.com/realms/eudiplo",
                    OIDC_SUB: "tenant_id",
                    OIDC_ALGORITHM: "RS256",
                },
                null,
            );
        });

        test("accepts a person's token without a stored client", async () => {
            const user = await strategy.validate({
                tenant_id: "acme",
                exp: NOW + 300,
                sub: "user-uuid",
                azp: "eudiplo-ui",
                realm_access: { roles: [Role.Issuances] },
            } as never);

            expect(user.roles).toEqual([Role.Issuances]);
            expect(user.client).toBeUndefined();
            expect(user.entity?.id).toBe("acme");
        });

        test("accepts a bearer access token", async () => {
            const user = await strategy.validate({
                tenant_id: "acme",
                exp: NOW + 300,
                sub: "user-uuid",
                typ: "Bearer",
                azp: "eudiplo-ui",
                realm_access: { roles: [Role.Issuances] },
            } as never);

            expect(user.roles).toEqual([Role.Issuances]);
        });

        test("refuses an ID token, which any client of the realm gets", async () => {
            // Without OIDC_AUDIENCE, its aud (the client) is not checked.
            await expect(
                strategy.validate({
                    tenant_id: "acme",
                    exp: NOW + 300,
                    sub: "user-uuid",
                    typ: "ID",
                    azp: "other-app",
                    aud: "other-app",
                    at_hash: "h",
                    realm_access: { roles: [Role.Issuances] },
                } as never),
            ).rejects.toThrow(
                new UnauthorizedException(
                    "Not an access token: the token carries at_hash, which only ID tokens carry; send the access token",
                ),
            );
            expect(clientsProvider.getClientById).not.toHaveBeenCalled();
        });

        test.each(["ID", "Refresh", "Offline", "Logout", "DPoP", ""])(
            "refuses a token whose typ claim is %j",
            async (typ) => {
                await expect(
                    strategy.validate({
                        tenant_id: "acme",
                        exp: NOW + 300,
                        sub: "user-uuid",
                        typ,
                        realm_access: { roles: [Role.Issuances] },
                    } as never),
                ).rejects.toThrow(
                    new UnauthorizedException(
                        "Not an access token: its typ claim is not Bearer, as on Keycloak access tokens; send the access token",
                    ),
                );
            },
        );

        test("keeps the roles of the claims and adds the stored client", async () => {
            clients.set("shop", {
                clientId: "shop",
                tenantId: "acme",
                roles: [],
                allowedIssuanceConfigs: ["pid"],
            });

            const user = await strategy.validate({
                tenant_id: "acme",
                exp: NOW + 300,
                azp: "shop",
                roles: [Role.IssuanceOffer],
            } as never);

            expect(user.roles).toEqual([Role.IssuanceOffer]);
            expect(user.client?.allowedIssuanceConfigs).toEqual(["pid"]);
        });

        test("leaves out a tenant that does not exist", async () => {
            tenantService.getTenant.mockRejectedValueOnce(
                new TenantNotFound("gone"),
            );

            const user = await strategy.validate({
                tenant_id: "gone",
                exp: NOW + 300,
                azp: "eudiplo-ui",
                realm_access: { roles: [Role.Issuances] },
            } as never);

            expect(user.entity).toBeUndefined();
        });

        test("fails when the client lookup fails, instead of dropping its limits", async () => {
            clientsProvider.getClientById.mockRejectedValueOnce(
                new Error("db down"),
            );

            await expect(
                strategy.validate({
                    tenant_id: "acme",
                    exp: NOW + 300,
                    azp: "shop",
                    roles: [Role.IssuanceOffer],
                } as never),
            ).rejects.toThrow("db down");
        });

        test("takes the roles from OIDC_ROLES_CLAIM when it is set", async () => {
            const withClaim = strategyFor(
                {
                    OIDC: "https://keycloak.example.com/realms/eudiplo",
                    OIDC_INTERNAL_ISSUER_URL:
                        "https://keycloak.example.com/realms/eudiplo",
                    OIDC_SUB: "tenant_id",
                    OIDC_ALGORITHM: "RS256",
                    OIDC_ROLES_CLAIM: "resource_access.eudiplo.roles",
                },
                null,
            );

            const user = await withClaim.validate({
                tenant_id: "acme",
                exp: NOW + 300,
                azp: "eudiplo-ui",
                realm_access: { roles: [Role.Tenants] },
                resource_access: { eudiplo: { roles: [Role.Issuances] } },
            } as never);

            expect(user.roles).toEqual([Role.Issuances]);
        });

        test("checks the realm's issuer and keys, and no audience unless it is set", () => {
            const keycloak = {
                OIDC: "https://keycloak.example.com/realms/eudiplo",
                OIDC_INTERNAL_ISSUER_URL: "http://keycloak:8080/realms/eudiplo",
                OIDC_SUB: "tenant_id",
                OIDC_ALGORITHM: "RS256",
            };

            expect(
                externalTokenChecks(
                    readAuthSettings(configService(keycloak)) as never,
                    null,
                ),
            ).toEqual({
                issuer: "http://keycloak:8080/realms/eudiplo",
                jwksUri:
                    "http://keycloak:8080/realms/eudiplo/protocol/openid-connect/certs",
                audience: undefined,
                algorithms: ["RS256"],
                trustedOrigins: [
                    "https://keycloak.example.com",
                    "http://keycloak:8080",
                ],
            });
            expect(
                externalTokenChecks(
                    readAuthSettings(
                        configService({
                            ...keycloak,
                            OIDC_AUDIENCE: "eudiplo",
                        }),
                    ) as never,
                    null,
                ).audience,
            ).toBe("eudiplo");
        });

        test("takes no roles from a roles claim that is a string", async () => {
            const user = await strategy.validate({
                tenant_id: "acme",
                exp: NOW + 300,
                sub: "user-uuid",
                roles: "not-tenant:admin-really",
            } as never);

            expect(user.roles).toEqual([]);
        });

        test("refuses a token without expiry, which would never expire", async () => {
            // Such as a signed userinfo response, which has no typ claim.
            await expect(
                strategy.validate({
                    tenant_id: "acme",
                    sub: "user-uuid",
                    realm_access: { roles: [Role.Issuances] },
                } as never),
            ).rejects.toThrow(
                new UnauthorizedException("Access token has no expiry"),
            );
        });

        test("rejects a token whose client ID now belongs to another tenant", async () => {
            clients.set("shop", {
                clientId: "shop",
                tenantId: "other",
                roles: [],
            });

            await expect(
                strategy.validate({
                    tenant_id: "acme",
                    exp: NOW + 300,
                    azp: "shop",
                    roles: [Role.IssuanceOffer],
                } as never),
            ).rejects.toThrow(UnauthorizedException);
        });
    });
    describe("other OpenID Connect provider", () => {
        const settings = {
            OIDC: "https://auth.example.com/application/o/eudiplo/",
            OIDC_PROVIDER: "generic",
            OIDC_INTERNAL_ISSUER_URL:
                "http://authentik:9000/application/o/eudiplo/",
            OIDC_AUDIENCE: "eudiplo-api",
            OIDC_SUB: "tenant_id",
            OIDC_ALGORITHM: "RS256",
            OIDC_ROLES_CLAIM: "urn:zitadel:iam:org:project:roles",
        };
        const metadata = {
            issuer: "https://auth.example.com/application/o/eudiplo/",
            jwks_uri: "https://auth.example.com/application/o/eudiplo/jwks/",
            token_endpoint: "https://auth.example.com/application/o/token/",
        };

        test("takes the roles from the keys of an object claim and keeps no client", async () => {
            const strategy = strategyFor(
                settings,
                metadata,
                new IdpManagedClientsProvider({
                    findOne: async () => null,
                } as never),
            );

            const user = await strategy.validate({
                tenant_id: "acme",
                sub: "person",
                azp: "eudiplo-ui",
                exp: NOW + 300,
                "urn:zitadel:iam:org:project:roles": {
                    [Role.Issuances]: { "1": "acme" },
                },
            } as never);

            expect(user.roles).toEqual([Role.Issuances]);
            expect(user.entity?.id).toBe("acme");
            expect(user.subject).toBe("person");
            expect(user.client).toBeUndefined();
        });

        test("ignores a typ claim, which only Keycloak defines", async () => {
            const user = await strategyFor(settings, metadata).validate({
                tenant_id: "acme",
                sub: "person",
                exp: NOW + 300,
                typ: "something-else",
            } as never);

            expect(user.subject).toBe("person");
        });

        test("refuses an ID token that carries the audience too", async () => {
            const strategy = strategyFor(settings, metadata);

            await expect(
                strategy.validate({
                    tenant_id: "acme",
                    sub: "person",
                    exp: NOW + 300,
                    nonce: "n",
                    at_hash: "h",
                } as never),
            ).rejects.toThrow(
                "Not an access token: the token carries at_hash, which only ID tokens carry; send the access token",
            );
        });

        describe("client records left from an earlier mode", () => {
            /** A record the built-in server or Keycloak mode created. */
            const leftover = (tenantId: string | null) =>
                new IdpManagedClientsProvider({
                    findOne: async ({
                        where,
                    }: {
                        where: { clientId: string };
                    }) =>
                        where.clientId === "shop"
                            ? {
                                  clientId: "shop",
                                  tenantId,
                                  roles: [Role.Clients],
                                  allowedIssuanceConfigs: ["loyalty-card"],
                              }
                            : null,
                } as never);
            const shopToken = {
                tenant_id: "acme",
                sub: "service-account-shop",
                azp: "shop",
                exp: NOW + 300,
                "urn:zitadel:iam:org:project:roles": {
                    [Role.IssuanceOffer]: {},
                },
            };

            test("apply their limits to the client's tokens of the same tenant", async () => {
                const user = await strategyFor(
                    settings,
                    metadata,
                    leftover("acme"),
                ).validate(shopToken as never);

                expect(user.client?.allowedIssuanceConfigs).toEqual([
                    "loyalty-card",
                ]);
                // The roles still come from the token.
                expect(user.roles).toEqual([Role.IssuanceOffer]);
            });

            test("refuse the client's tokens for another tenant", async () => {
                await expect(
                    strategyFor(settings, metadata, leftover("other")).validate(
                        shopToken as never,
                    ),
                ).rejects.toThrow(
                    new UnauthorizedException(
                        "The client of this token does not exist",
                    ),
                );
            });
        });

        test("refuses a token without expiry, which would never expire", async () => {
            await expect(
                strategyFor(settings, metadata).validate({
                    tenant_id: "acme",
                    sub: "person",
                } as never),
            ).rejects.toThrow(
                new UnauthorizedException("Access token has no expiry"),
            );
        });

        test("checks the discovery document's issuer, keys and the audience", () => {
            expect(
                externalTokenChecks(
                    readAuthSettings(configService(settings)) as never,
                    metadata,
                ),
            ).toEqual({
                issuer: metadata.issuer,
                jwksUri: metadata.jwks_uri,
                audience: "eudiplo-api",
                algorithms: ["RS256"],
                // Not the origin of a key set only the document names.
                trustedOrigins: [
                    "https://auth.example.com",
                    "http://authentik:9000",
                ],
            });
        });

        test("loads the keys from OIDC_JWKS_URI when it is set", () => {
            const checks = externalTokenChecks(
                readAuthSettings(
                    configService({
                        ...settings,
                        OIDC_JWKS_URI: "http://authentik:9000/jwks/",
                    }),
                ) as never,
                metadata,
            );

            expect(checks.jwksUri).toBe("http://authentik:9000/jwks/");
            expect(checks.trustedOrigins).toContain("http://authentik:9000");
        });

        test("trusts the origin of OIDC_JWKS_URI, which the operator set", () => {
            const checks = externalTokenChecks(
                readAuthSettings(
                    configService({
                        ...settings,
                        OIDC_JWKS_URI: "http://keys.internal:8080/jwks",
                    }),
                ) as never,
                metadata,
            );

            expect(checks.trustedOrigins).toContain(
                "http://keys.internal:8080",
            );
        });

        test("cannot start without the discovery document", () => {
            expect(() => strategyFor(settings, null)).toThrow(
                "The OIDC discovery document was not loaded",
            );
        });
    });
});
