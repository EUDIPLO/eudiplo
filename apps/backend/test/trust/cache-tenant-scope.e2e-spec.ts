import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { generateKeyPair, SignJWT } from "jose";
import nock from "nock";
import request from "supertest";
import { App } from "supertest/types";
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
} from "vitest";
import { Role } from "../../src/auth/roles/role.enum.js";
import { StatusListVerifierService } from "../../src/trust/status-list-verifier.service.js";
import { TrustStoreService } from "../../src/trust/trust-store.service.js";
import {
    createMockTrustListJwt,
    generateSelfSignedCertificate,
} from "../issuance/attestation-trust-helpers.js";
import {
    clientToken,
    getTenantAdminToken,
    setupPresentationTestApp,
} from "../utils.js";

/**
 * The trust list, OpenID Federation and status list caches are shared by all
 * tenants. A tenant's caller sees and clears only the entries of its own
 * tenant; `tenants:manage` sees and clears those of all tenants.
 */
describe("Cache management per tenant", () => {
    let app: INestApplication<App>;
    let operatorToken: string;
    let tokenA: string;
    let tokenB: string;
    let offerToken: string;
    const suffix = crypto.randomUUID().slice(0, 8);
    const tenantA = `cache-a-${suffix}`;
    const tenantB = `cache-b-${suffix}`;
    const origin = "http://localhost:8787";
    const statusUri = (name: string) => `${origin}/status-${suffix}/${name}`;
    let statusListKey: CryptoKey;

    beforeAll(async () => {
        const ctx = await setupPresentationTestApp();
        app = ctx.app;
        operatorToken = await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: ctx.clientId,
                client_secret: ctx.clientSecret,
            })
            .expect(201)
            .then((res) => res.body.access_token);
        tokenA = await getTenantAdminToken(
            app,
            ctx.clientId,
            ctx.clientSecret,
            tenantA,
            [Role.Presentations, Role.Clients],
        );
        tokenB = await getTenantAdminToken(
            app,
            ctx.clientId,
            ctx.clientSecret,
            tenantB,
            [Role.Issuances],
        );
        offerToken = await clientToken(app, tokenA, `cache-offer-${suffix}`, [
            Role.PresentationRequest,
        ]);
        ({ privateKey: statusListKey } = await generateKeyPair("ES256"));
    });

    beforeEach(() => {
        // Requests to the mocked origin that no interceptor answers fail
        // here instead of reaching a server on that port.
        nock.disableNetConnect();
        nock.enableNetConnect(/^(127\.0\.0\.1|localhost):(?!8787$)/);
    });

    afterEach(() => {
        nock.cleanAll();
        nock.enableNetConnect();
        app.get(StatusListVerifierService).clearCache();
        app.get(TrustStoreService).clearCache();
    });

    afterAll(async () => {
        await app?.close();
    });

    /** Fetch the status list `name` into the cache for `tenantId`. */
    async function useStatusList(name: string, tenantId: string) {
        const uri = statusUri(name);
        const jwt = await new SignJWT({
            sub: uri,
            ttl: 600,
            status_list: { bits: 1, lst: "eNrbuRgAAhcBXQ" },
        })
            .setProtectedHeader({ alg: "ES256", typ: "statuslist+jwt" })
            .setIssuedAt()
            .sign(statusListKey);
        nock(origin)
            .get(new URL(uri).pathname)
            .reply(200, jwt, { "Content-Type": "application/statuslist+jwt" });
        await app
            .get(StatusListVerifierService)
            .getStatusListJwt(uri, tenantId);
    }

    const stats = (token: string) =>
        request(app.getHttpServer())
            .get("/cache/stats")
            .set("Authorization", `Bearer ${token}`)
            .expect(200)
            .then((res) => res.body.statusListCache);

    const clear = (path: string, token: string) =>
        request(app.getHttpServer())
            .delete(path)
            .set("Authorization", `Bearer ${token}`);

    test("lists only the status lists the caller's tenant used", async () => {
        await useStatusList("a", tenantA);
        await useStatusList("b", tenantB);
        await useStatusList("shared", tenantA);
        // Served from the cache, used by tenant B too.
        await app
            .get(StatusListVerifierService)
            .getStatusListJwt(statusUri("shared"), tenantB);

        await expect(stats(tokenA)).resolves.toEqual({
            size: 0,
            jwtCacheSize: 2,
            uris: [statusUri("a"), statusUri("shared")],
        });
        await expect(stats(tokenB)).resolves.toMatchObject({
            jwtCacheSize: 2,
            uris: [statusUri("b"), statusUri("shared")],
        });
        const all = await stats(operatorToken);
        expect(all.uris).toEqual(
            expect.arrayContaining([
                statusUri("a"),
                statusUri("b"),
                statusUri("shared"),
            ]),
        );
    });

    test("clears only the status lists the caller's tenant used", async () => {
        await useStatusList("a", tenantA);
        await useStatusList("b", tenantB);

        await clear("/cache/status-list", tokenA).expect(204);

        await expect(stats(tokenA)).resolves.toMatchObject({ uris: [] });
        await expect(stats(tokenB)).resolves.toMatchObject({
            uris: [statusUri("b")],
        });

        await clear("/cache", tokenB).expect(204);
        await expect(stats(tokenB)).resolves.toMatchObject({ uris: [] });
    });

    test("clears the status lists of all tenants for tenants:manage", async () => {
        await useStatusList("a", tenantA);
        await useStatusList("b", tenantB);

        await clear("/cache/status-list", operatorToken).expect(204);

        await expect(stats(operatorToken)).resolves.toEqual({
            size: 0,
            jwtCacheSize: 0,
            uris: [],
        });
    });

    test("clears only the trust lists of the caller's tenant", async () => {
        const signer = await generateSelfSignedCertificate();
        const provider = await generateSelfSignedCertificate();
        const path = `/trust-${suffix}`;
        const serve = async () =>
            nock(origin)
                .get(path)
                .reply(
                    200,
                    await createMockTrustListJwt(signer, provider.certificate),
                    { "Content-Type": "application/jwt" },
                );
        const load = (tenantId: string) =>
            app.get(TrustStoreService).getTrustStore({
                tenantId,
                lotes: [
                    {
                        url: `${origin}${path}`,
                        verifierX509Der: signer.certificate.toString("base64"),
                    },
                ],
            });

        await serve();
        await load(tenantA);
        await serve();
        await load(tenantB);

        await clear("/cache/trust-list", tokenA).expect(204);
        // Tenant B's store is still cached: nothing is served.
        await expect(load(tenantB)).resolves.toBeDefined();
        await expect(load(tenantA)).rejects.toThrow();

        await clear("/cache", operatorToken).expect(204);
        await expect(load(tenantB)).rejects.toThrow();
    });

    test("refuses callers without a cache management role", async () => {
        await clear("/cache", offerToken).expect(403);
        await clear("/cache/status-list", offerToken).expect(403);
        await request(app.getHttpServer())
            .get("/cache/stats")
            .set("Authorization", `Bearer ${offerToken}`)
            .expect(403);
    });

    test("keeps forgetting sequence numbers for tenant roles only", async () => {
        await clear("/cache/trust-list/sequence-numbers", tokenA).expect(204);
        await clear("/cache/trust-list/sequence-numbers", operatorToken).expect(
            403,
        );
    });
});
