import { UnauthorizedException } from "@nestjs/common";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { Strategy } from "passport-jwt";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ClientData } from "./client/domain/client-data.js";
import { TenantNotFound } from "./tenant/domain/tenant-data.js";
import { JwtStrategy } from "./jwt.strategy.js";
import { Role } from "./roles/role.enum.js";
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
            strategy = new JwtStrategy(
                configService({ MASTER_SECRET: "x".repeat(32) }),
                tenantService as never,
                clientsProvider as never,
            );
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
            strategy = new JwtStrategy(
                configService({
                    OIDC: "https://keycloak.example.com/realms/eudiplo",
                    OIDC_INTERNAL_ISSUER_URL:
                        "https://keycloak.example.com/realms/eudiplo",
                    OIDC_SUB: "tenant_id",
                    OIDC_ALGORITHM: "RS256",
                }),
                tenantService as never,
                clientsProvider as never,
            );
        });

        test("accepts a person's token without a stored client", async () => {
            const user = await strategy.validate({
                tenant_id: "acme",
                sub: "user-uuid",
                azp: "eudiplo-ui",
                realm_access: { roles: [Role.Issuances] },
            } as never);

            expect(user.roles).toEqual([Role.Issuances]);
            expect(user.client).toBeUndefined();
            expect(user.entity?.id).toBe("acme");
        });

        test("keeps the roles of the claims and adds the stored client", async () => {
            clients.set("shop", {
                clientId: "shop",
                tenantId: "acme",
                roles: [],
                allowedIssuanceConfigs: ["pid"],
            });

            const user = await strategy.validate({
                tenant_id: "acme",
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
                    azp: "shop",
                    roles: [Role.IssuanceOffer],
                } as never),
            ).rejects.toThrow("db down");
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
                    azp: "shop",
                    roles: [Role.IssuanceOffer],
                } as never),
            ).rejects.toThrow(UnauthorizedException);
        });
    });

    describe("Keycloak token audience", () => {
        const issuer = "https://keycloak.example.com/realms/eudiplo";
        const keycloak = {
            OIDC: issuer,
            OIDC_INTERNAL_ISSUER_URL: issuer,
            OIDC_SUB: "tenant_id",
            OIDC_ALGORITHM: "RS256",
        };
        const audience = "https://eudiplo.example.com/api";

        /** The verification options JwtStrategy hands to passport-jwt. */
        const optionsFor = (values: Record<string, string>) =>
            JwtStrategy["getExternalOIDCConfig"](configService(values));

        /**
         * Verifies `aud` tokens with passport-jwt and the strategy's
         * options, the realm key standing in for the JWKS.
         */
        async function verify(
            values: Record<string, string>,
            aud: string | string[] | undefined,
        ): Promise<"accepted" | "rejected"> {
            const { publicKey, privateKey } = await generateKeyPair("RS256");
            const jwt = new SignJWT({ tenant_id: "acme" })
                .setProtectedHeader({ alg: "RS256" })
                .setIssuer(issuer)
                .setIssuedAt()
                .setExpirationTime("5m");
            if (aud) jwt.setAudience(aud);
            const token = await jwt.sign(privateKey);
            const { secretOrKeyProvider: _, ...options } = optionsFor(values);
            const strategy = new Strategy(
                { ...options, secretOrKey: await exportSPKI(publicKey) },
                (_payload: unknown, done: (e: null, u: object) => void) =>
                    done(null, {}),
            );
            return new Promise((resolve, reject) => {
                Object.assign(strategy, {
                    success: () => resolve("accepted"),
                    fail: () => resolve("rejected"),
                    error: reject,
                });
                strategy.authenticate(
                    { headers: { authorization: `Bearer ${token}` } } as never,
                    {},
                );
            });
        }

        test("is not checked without OIDC_AUDIENCE, as before", async () => {
            expect(optionsFor(keycloak)).not.toHaveProperty("audience");
            const empty = { ...keycloak, OIDC_AUDIENCE: "" };
            expect(optionsFor(empty)).not.toHaveProperty("audience");
            await expect(verify(empty, "account")).resolves.toBe("accepted");
            await expect(verify(keycloak, undefined)).resolves.toBe("accepted");
            await expect(verify(keycloak, "account")).resolves.toBe("accepted");
        });

        test("must contain OIDC_AUDIENCE when it is set", async () => {
            const values = { ...keycloak, OIDC_AUDIENCE: audience };

            await expect(verify(values, audience)).resolves.toBe("accepted");
            await expect(verify(values, ["account", audience])).resolves.toBe(
                "accepted",
            );
            await expect(verify(values, "account")).resolves.toBe("rejected");
            await expect(verify(values, undefined)).resolves.toBe("rejected");
        });
    });
});
