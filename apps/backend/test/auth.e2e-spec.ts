import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppModule } from "../src/app.module.js";

describe("Authentication (e2e)", () => {
    let app: INestApplication;
    let clientId: string;
    let clientSecret: string;

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(new ValidationPipe());

        await app.init();
        const configService = app.get(ConfigService);
        clientId = configService.getOrThrow<string>("AUTH_CLIENT_ID");
        clientSecret = configService.getOrThrow<string>("AUTH_CLIENT_SECRET");
    });

    afterAll(async () => {
        await app?.close();
    });

    test("should get OAuth2 token with valid client credentials in request body", async () => {
        const response = await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: clientId,
                client_secret: clientSecret,
            })
            .expect(201);

        expect(response.body).toHaveProperty("access_token");
        expect(response.body).toHaveProperty("token_type", "Bearer");
        expect(response.body).toHaveProperty("expires_in", 86400);
        expect(typeof response.body.access_token).toBe("string");
    });

    test("should get OAuth2 token with valid client credentials in Authorization header", async () => {
        const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
            "base64",
        );

        const response = await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .set("Authorization", `Basic ${credentials}`)
            .send({
                grant_type: "client_credentials",
            })
            .expect(201);

        expect(response.body).toHaveProperty("access_token");
        expect(response.body).toHaveProperty("token_type", "Bearer");
        expect(response.body).toHaveProperty("expires_in", 86400);
        expect(typeof response.body.access_token).toBe("string");
    });

    test("should reject invalid client credentials", async () => {
        await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: "invalid-client",
                client_secret: "invalid-secret",
            })
            .expect(401)
            .expect((res) => {
                expect(res.body.message).toBe("Invalid client credentials");
            });
    });

    test("should reject unsupported grant type", async () => {
        await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "authorization_code",
                client_id: clientId,
                client_secret: clientSecret,
            })
            .expect(401)
            .expect((res) => {
                expect(res.body.message).toBe(
                    "Only client_credentials grant type is supported",
                );
            });
    });

    test("should reject missing client credentials", async () => {
        await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: clientId,
                // Missing client_secret
            })
            .expect(401);
    });

    test("should reject access without token", async () => {
        await request(app.getHttpServer())
            .get("/session") // Protected endpoint
            .expect(401);
    });

    test("should reject access with invalid token", async () => {
        await request(app.getHttpServer())
            .get("/session") // Protected endpoint
            .set("Authorization", "Bearer invalid-token")
            .expect(401);
    });
});
