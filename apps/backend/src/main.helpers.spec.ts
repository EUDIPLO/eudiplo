import { Controller, Get, INestApplication, Post } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { App } from "supertest/types";
import { afterEach, describe, expect, it } from "vitest";
import {
    configureCors,
    GLOBAL_PREFIX_EXCLUSIONS,
    isManagementApiPath,
} from "./main.helpers.js";

@Controller("tenants")
class ManagementController {
    @Get()
    list() {
        return [];
    }
}

@Controller("presentations/:sessionId/oid4vp")
class ProtocolController {
    @Post()
    respond() {
        return {};
    }
}

const ALLOWED = "https://console.example.com";
const OTHER = "https://evil.example.com";

async function createApp(allowedOrigins: string[]) {
    const moduleRef = await Test.createTestingModule({
        controllers: [ManagementController, ProtocolController],
    }).compile();
    const app = moduleRef.createNestApplication<INestApplication<App>>({
        logger: false,
    });
    configureCors(app, allowedOrigins);
    app.setGlobalPrefix("api", { exclude: GLOBAL_PREFIX_EXCLUSIONS });
    await app.init();
    return app;
}

function preflight(app: INestApplication<App>, path: string, origin: string) {
    return request(app.getHttpServer())
        .options(path)
        .set("Origin", origin)
        .set("Access-Control-Request-Method", "POST")
        .set("Access-Control-Request-Headers", "authorization,content-type");
}

describe("isManagementApiPath", () => {
    it.each(["/api", "/api/", "/api/tenants", "/API/tenants"])(
        "treats %s as management API",
        (path) => {
            expect(isManagementApiPath(path)).toBe(true);
        },
    );

    it.each([
        "/",
        "/health",
        "/apis",
        "/apidocs",
        "/presentations/abc/oid4vp",
        "/.well-known/openid-credential-issuer",
    ])("treats %s as not management API", (path) => {
        expect(isManagementApiPath(path)).toBe(false);
    });
});

describe("configureCors", () => {
    let app: INestApplication<App> | undefined;

    afterEach(async () => {
        await app?.close();
        app = undefined;
    });

    it("allows every origin everywhere when no origins are configured", async () => {
        app = await createApp([]);

        const res = await preflight(app, "/api/tenants", OTHER);
        expect(res.status).toBe(204);
        expect(res.headers["access-control-allow-origin"]).toBe("*");

        const get = await request(app.getHttpServer())
            .get("/api/tenants")
            .set("Origin", OTHER);
        expect(get.headers["access-control-allow-origin"]).toBe("*");
    });

    it("allows a configured origin on the management API", async () => {
        app = await createApp([ALLOWED, "http://localhost:4200"]);

        const res = await preflight(app, "/api/tenants", ALLOWED);
        expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
        expect(res.headers.vary).toContain("Origin");

        const get = await request(app.getHttpServer())
            .get("/api/tenants")
            .set("Origin", ALLOWED);
        expect(get.status).toBe(200);
        expect(get.headers["access-control-allow-origin"]).toBe(ALLOWED);
    });

    it("withholds CORS headers from other origins on the management API", async () => {
        app = await createApp([ALLOWED]);

        for (const path of ["/api/tenants", "/API/tenants"]) {
            const res = await preflight(app, path, OTHER);
            expect(res.headers["access-control-allow-origin"]).toBeUndefined();
        }

        const get = await request(app.getHttpServer())
            .get("/api/tenants")
            .set("Origin", OTHER);
        expect(get.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("keeps protocol endpoints open to all origins", async () => {
        app = await createApp([ALLOWED]);

        const res = await preflight(app, "/presentations/abc/oid4vp", OTHER);
        expect(res.status).toBe(204);
        expect(res.headers["access-control-allow-origin"]).toBe("*");

        const post = await request(app.getHttpServer())
            .post("/presentations/abc/oid4vp")
            .set("Origin", OTHER);
        expect(post.status).toBe(201);
        expect(post.headers["access-control-allow-origin"]).toBe("*");
    });
});
