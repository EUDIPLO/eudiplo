import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
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
 * `GET /trust-list-status` shows how the caller's tenant last loaded each
 * trust list, as the trust store records it.
 */
describe("Trust list status", () => {
    let app: INestApplication<App>;
    let tokenA: string;
    let tokenB: string;
    let offerToken: string;
    const suffix = crypto.randomUUID().slice(0, 8);
    const tenantA = `tl-status-a-${suffix}`;
    const tenantB = `tl-status-b-${suffix}`;
    const origin = "http://localhost:8788";

    beforeAll(async () => {
        const ctx = await setupPresentationTestApp();
        app = ctx.app;
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
        offerToken = await clientToken(app, tokenA, `tl-status-${suffix}`, [
            Role.PresentationRequest,
        ]);
    });

    beforeEach(() => {
        nock.disableNetConnect();
        nock.enableNetConnect(/^(127\.0\.0\.1|localhost):(?!8788$)/);
    });

    afterEach(() => {
        nock.cleanAll();
        nock.enableNetConnect();
        app.get(TrustStoreService).clearCache();
    });

    afterAll(async () => {
        await app?.close();
    });

    const status = (token: string) =>
        request(app.getHttpServer())
            .get("/trust-list-status")
            .set("Authorization", `Bearer ${token}`);

    test("shows an accepted list to its tenant only, and a failed load with its HTTP status", async () => {
        const signer = await generateSelfSignedCertificate();
        const provider = await generateSelfSignedCertificate();
        const path = `/trust-${suffix}`;
        const url = `${origin}${path}`;
        const load = () =>
            app.get(TrustStoreService).getTrustStore({
                tenantId: tenantA,
                lotes: [
                    {
                        url,
                        verifierX509Der: signer.certificate.toString("base64"),
                    },
                ],
            });

        nock(origin)
            .get(path)
            .reply(
                200,
                await createMockTrustListJwt(signer, provider.certificate, {
                    sequenceNumber: 3,
                }),
                { "Content-Type": "application/jwt" },
            );
        await load();

        const accepted = await status(tokenA).expect(200);
        expect(accepted.body).toEqual([
            {
                url,
                trustListId: null,
                outcome: "accepted",
                reason: null,
                checkedAt: expect.any(String),
                verifiedAt: accepted.body[0].checkedAt,
                acceptedAt: accepted.body[0].checkedAt,
                nextUpdate: expect.any(String),
                sequenceNumber: 3,
                entities: 1,
            },
        ]);
        expect(Number.isNaN(Date.parse(accepted.body[0].checkedAt))).toBe(
            false,
        );
        // Another tenant sees none of tenant A's lists.
        await status(tokenB).expect(200, []);

        app.get(TrustStoreService).clearCache();
        nock(origin).get(path).reply(503);
        await expect(load()).rejects.toThrow();

        const failed = await status(tokenA).expect(200);
        expect(failed.body).toEqual([
            expect.objectContaining({
                url,
                outcome: "failed",
                reason: "The list URL answered with HTTP status 503",
                // The last verified version stays.
                acceptedAt: accepted.body[0].acceptedAt,
                sequenceNumber: 3,
                entities: 1,
            }),
        ]);
    });

    test("is refused without issuance:manage or presentation:manage", async () => {
        await status(offerToken).expect(403);
    });
});
