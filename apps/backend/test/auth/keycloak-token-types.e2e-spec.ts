import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { AllExceptionsFilter } from "../../src/all-exceptions.filter.js";
import { CLIENTS_PROVIDER } from "../../src/auth/client/client.provider.js";
import { Role } from "../../src/auth/roles/role.enum.js";
import { USERS_PROVIDER } from "../../src/auth/user/user.provider.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";

/**
 * EUDIPLO with Keycloak (`OIDC` set, `OIDC_PROVIDER` left at its default) and
 * no `OIDC_AUDIENCE`: the realm signs the ID tokens of every client with the
 * keys of its access tokens. The admin API adapters are replaced, as no
 * Keycloak runs; the realm's keys come from a local server at Keycloak's path.
 */
describe("Keycloak token types (e2e)", () => {
    let app: INestApplication<App>;
    let realm: Server;
    let issuer: string;
    let sign: (
        claims: JWTPayload,
        options?: { typ?: string; audience?: string },
    ) => Promise<string>;

    const me = (token: string) =>
        request(app.getHttpServer())
            .get("/auth/me")
            .set("Authorization", `Bearer ${token}`);

    /** Claims of a person signed in to some client of the realm. */
    const person = {
        sub: "person-1",
        realm_access: { roles: [Role.SessionsRead] },
    };

    beforeAll(async () => {
        const { privateKey, publicKey } = await generateKeyPair("RS256");
        const jwk = {
            ...(await exportJWK(publicKey)),
            kid: "realm-key",
            alg: "RS256",
            use: "sig",
        };
        realm = createServer((req, res) => {
            const found =
                req.url === "/realms/eudiplo/protocol/openid-connect/certs";
            res.writeHead(found ? 200 : 404, {
                "content-type": "application/json",
            });
            res.end(JSON.stringify(found ? { keys: [jwk] } : {}));
        });
        await new Promise<void>((resolve) =>
            realm.listen(0, "127.0.0.1", resolve),
        );
        issuer = `http://127.0.0.1:${(realm.address() as AddressInfo).port}/realms/eudiplo`;
        sign = (claims, options = {}) =>
            new SignJWT(claims)
                .setProtectedHeader({
                    alg: "RS256",
                    kid: "realm-key",
                    typ: options.typ ?? "JWT",
                })
                .setIssuer(issuer)
                .setAudience(options.audience ?? "account")
                .setIssuedAt()
                .setExpirationTime("5m")
                .sign(privateKey);

        rmSync("../../tmp/service.db", { force: true });
        vi.stubEnv("OIDC", issuer);
        vi.stubEnv("OIDC_CLIENT_ID", "eudiplo-admin");
        vi.stubEnv("OIDC_CLIENT_SECRET", "unused");
        vi.stubEnv("CONFIG_IMPORT_MODE", "disabled");
        // AppModule reads the environment when it is imported.
        const { AppModule } = await import("../../src/app.module.js");
        const moduleFixture = await Test.createTestingModule({
            imports: [AppModule],
        })
            .overrideProvider(CLIENTS_PROVIDER)
            .useValue({ getClientById: async () => null })
            .overrideProvider(USERS_PROVIDER)
            .useValue({})
            .compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(createAppValidationPipe());
        app.useGlobalFilters(new AllExceptionsFilter());
        await app.init();
    });

    afterAll(async () => {
        await app?.close();
        await new Promise((resolve) => realm?.close(resolve));
        vi.unstubAllEnvs();
    });

    test("accepts an access token of the realm", async () => {
        const token = await sign({
            ...person,
            typ: "Bearer",
            azp: "eudiplo-ui",
        });

        const response = await me(token).expect(200);

        expect(response.body.roles).toEqual([Role.SessionsRead]);
    });

    test("accepts an RFC 9068 access token", async () => {
        const token = await sign(
            { ...person, typ: "Bearer", azp: "eudiplo-ui" },
            { typ: "at+jwt" },
        );

        const response = await me(token).expect(200);

        expect(response.body.roles).toEqual([Role.SessionsRead]);
    });

    test("refuses the ID token of another client of the realm", async () => {
        // As Keycloak issues it in the code flow: aud and azp are the client.
        const token = await sign(
            {
                ...person,
                typ: "ID",
                azp: "other-app",
                nonce: "n-0S6_WzA2Mj",
                at_hash: "77QmUPtjPfzWtF2AnpK9RQ",
            },
            { audience: "other-app" },
        );

        const response = await me(token).expect(401);

        expect(response.body.message).toBe(
            "Not an access token: the token carries at_hash, which only ID tokens carry; send the access token",
        );
    });

    test("refuses an ID token without at_hash by its typ claim", async () => {
        // Token exchange issues ID tokens without an access token to hash.
        const token = await sign(
            { ...person, typ: "ID", azp: "other-app" },
            { audience: "other-app" },
        );

        const response = await me(token).expect(401);

        expect(response.body.message).toBe(
            "Not an access token: its typ claim is not Bearer, as on Keycloak access tokens; send the access token",
        );
    });

    test("refuses a token whose header names another type", async () => {
        const token = await sign(
            { ...person, typ: "Logout" },
            { typ: "logout+jwt" },
        );

        const response = await me(token).expect(401);

        expect(response.body.message).toBe(
            "Not an access token: its header names another typ than at+jwt or JWT",
        );
    });
});
