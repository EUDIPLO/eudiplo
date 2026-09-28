import { INestApplication } from "@nestjs/common";
import { importX509, jwtVerify } from "jose";
import request from "supertest";
import { App } from "supertest/types";
import { Agent, setGlobalDispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { IssuanceTestContext, setupIssuanceTestApp } from "../utils.js";

setGlobalDispatcher(
    new Agent({
        connect: {
            rejectUnauthorized: false,
        },
    }),
);

describe("Issuance - Metadata", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let ctx: IssuanceTestContext;

    beforeAll(async () => {
        ctx = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
    });

    afterAll(async () => {
        await app?.close();
    });

    test("get issuer metadata", async () => {
        const tenantId = "root";

        const res = await request(app.getHttpServer())
            .get(`/.well-known/openid-credential-issuer/issuers/${tenantId}`)
            .trustLocalhost()
            .set("Accept", "application/json")
            .expect(200);
        expect(res.body).toBeDefined();
        expect(res.body.credential_issuer).toBeDefined();
        expect(res.body.credential_issuer).toBe(
            `http://localhost:3000/issuers/${tenantId}`,
        );
    });

    test("get signed issuer metadata", async () => {
        const tenantId = "root";

        const res = await request(app.getHttpServer())
            .get(`/.well-known/openid-credential-issuer/issuers/${tenantId}`)
            .trustLocalhost()
            .set("Accept", "application/jwt")
            .expect(200);
        expect(res.body).toBeDefined();
        // Get the x5c header and verify the signature
        const jwtHeader = JSON.parse(
            Buffer.from(res.text.split(".")[0], "base64").toString("utf-8"),
        );
        expect(jwtHeader.typ).toBe("openidvci-issuer-metadata+jwt");
        expect(jwtHeader.alg).toBeDefined();
        expect(jwtHeader.x5c).toBeDefined();
        expect(jwtHeader.x5c.length).toBeGreaterThan(0);
        // Verify the signature
        const cert = `-----BEGIN CERTIFICATE-----\n${jwtHeader.x5c[0]}\n-----END CERTIFICATE-----`;
        const key = await importX509(cert, "ES256");
        // Use jose to verify the signature
        const { payload } = await jwtVerify(res.text, key, {
            algorithms: [jwtHeader.alg],
        }).catch((err) => {
            console.error("JWT verification failed:", err);
            throw err;
        });
        expect(payload.iss).toBeDefined();
    });

    test("metadata omits notification endpoint when disabled", async () => {
        await request(app.getHttpServer())
            .post("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                notificationEndpointEnabled: false,
                authorizationServers: [
                    {
                        id: "issuer-built-in",
                        type: "built-in",
                        enabled: true,
                    },
                ],
            })
            .expect(201);

        const res = await request(app.getHttpServer())
            .get("/.well-known/openid-credential-issuer/issuers/root")
            .trustLocalhost()
            .set("Accept", "application/json")
            .expect(200);

        expect(res.body.notification_endpoint).toBeUndefined();
    });

    test("disabled notification endpoint is rejected", async () => {
        await request(app.getHttpServer())
            .post("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                notificationEndpointEnabled: false,
                authorizationServers: [
                    {
                        id: "issuer-built-in",
                        type: "built-in",
                        enabled: true,
                    },
                ],
            })
            .expect(201);

        await request(app.getHttpServer())
            .post("/issuers/root/vci/notification")
            .trustLocalhost()
            .send({
                notification_id: "does-not-matter",
                event: "credential_accepted",
            })
            .expect(404);
    });

    test("create oid4vci offer", async () => {
        const res = await request(app.getHttpServer())
            .post("/issuer/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: "uri",
                credentialConfigurationIds: ["pid-no-key"],
                flow: "pre_authorized_code",
            })
            .expect(201);

        expect(res.body).toBeDefined();
        const session = res.body.session;

        // Check if the session exists
        await request(app.getHttpServer())
            .get(`/session/${session}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200)
            .expect((res) => {
                expect(res.body.id).toBe(session);
            });
    });

    test("ask for an invalid oid4vci offer", async () => {
        await request(app.getHttpServer())
            .post("/issuer/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: "uri",
            })
            .expect(400);
    });
});
