import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { App } from "supertest/types";
import { beforeAll, describe, expect, test } from "vitest";
import { AppModule } from "../src/app.module.js";

describe("Home", () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(new ValidationPipe());

        await app.init();
    });

    test("GET / returns EUDIPLO", () => {
        return request(app.getHttpServer())
            .get("/")
            .expect(200)
            .expect((res) => {
                expect(res.body).toEqual({
                    service: "EUDIPLO",
                    documentation: expect.any(String),
                });
                expect(res.body).not.toHaveProperty("version");
            });
    });

    test("GET /version requires authentication", () => {
        return request(app.getHttpServer()).get("/version").expect(401);
    });

    test("GET /frontend-config returns the public URL", async () => {
        const configService = app.get(ConfigService);
        const token = await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: configService.getOrThrow<string>("AUTH_CLIENT_ID"),
                client_secret:
                    configService.getOrThrow<string>("AUTH_CLIENT_SECRET"),
            })
            .expect(201)
            .then((res) => res.body.access_token as string);

        const response = await request(app.getHttpServer())
            .get("/frontend-config")
            .set("Authorization", `Bearer ${token}`)
            .expect(200);

        // The E2E environment keeps the PUBLIC_URL default.
        expect(response.body.publicUrl).toBe("http://localhost:3000");
    });
});
