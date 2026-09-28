import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import {
    PostgreSqlContainer,
    StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppModule } from "../src/app.module.js";
import { describeWithContainers } from "./container-runtime.js";

describe("Database SSL invalid CA path", () => {
    test("bootstrap fails early when DB_SSL_CA_PATH cannot be read", async () => {
        const appModulePromise = Test.createTestingModule({
            imports: [
                ConfigModule.forRoot({
                    isGlobal: true,
                    load: [
                        () => ({
                            DB_TYPE: "postgres",
                            DB_HOST: "localhost",
                            DB_PORT: "5432",
                            DB_USERNAME: "postgres",
                            DB_PASSWORD: "postgres",
                            DB_DATABASE: "postgres",
                            DB_SSL: "true",
                            DB_SSL_CA_PATH: "/path/does/not/exist/ca.crt",
                        }),
                    ],
                }),
                AppModule,
            ],
        }).compile();

        await expect(async () => {
            const moduleFixture = await appModulePromise;
            const app = moduleFixture.createNestApplication();
            await app.init();
        }).rejects.toThrowError(/Failed to read DB_SSL_CA_PATH/);
    });
});

describeWithContainers("Database SSL with CA path (positive)", () => {
    let app: INestApplication<App>;
    let container: StartedPostgreSqlContainer;
    let certDir: string;

    beforeAll(async () => {
        // Generate a self-signed cert with SAN so Node.js hostname verification
        // passes when connecting to localhost / 127.0.0.1.
        certDir = join(tmpdir(), `pg-ssl-e2e-${Date.now()}`);
        mkdirSync(certDir, { recursive: true });

        const opensslCnf = [
            "[req]",
            "distinguished_name = req_distinguished_name",
            "x509_extensions = v3_req",
            "prompt = no",
            "",
            "[req_distinguished_name]",
            "CN = localhost",
            "",
            "[v3_req]",
            "subjectAltName = @alt_names",
            "",
            "[alt_names]",
            "DNS.1 = localhost",
            "DNS.2 = host.testcontainers.internal",
            "IP.1 = 127.0.0.1",
        ].join("\n");
        writeFileSync(join(certDir, "openssl.cnf"), opensslCnf);

        execSync(
            `openssl req -x509 -newkey rsa:2048 \
                -keyout "${join(certDir, "server.key")}" \
                -out "${join(certDir, "server.crt")}" \
                -days 1 -nodes \
                -config "${join(certDir, "openssl.cnf")}"`,
            { stdio: "pipe" },
        );

        container = await new PostgreSqlContainer("postgres:16")
            .withDatabase("test_db")
            .withUsername("test")
            .withPassword("test_password")
            .withSSLCert(
                join(certDir, "server.crt"),
                join(certDir, "server.crt"),
                join(certDir, "server.key"),
            )
            .start();

        const moduleFixture = await Test.createTestingModule({
            imports: [
                ConfigModule.forRoot({
                    isGlobal: true,
                    load: [
                        () => ({
                            DB_TYPE: "postgres",
                            DB_HOST: container.getHost(),
                            DB_PORT: container.getPort().toString(),
                            DB_USERNAME: "test",
                            DB_PASSWORD: "test_password",
                            DB_DATABASE: "test_db",
                            DB_SSL: "true",
                            DB_SSL_CA_PATH: join(certDir, "server.crt"),
                            DB_SYNCHRONIZE: "true",
                            DB_MIGRATIONS_RUN: "true",
                        }),
                    ],
                }),
                AppModule,
            ],
        }).compile();

        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(new ValidationPipe());
        await app.init();
    }, 120_000);

    afterAll(async () => {
        await app?.close();
        await container?.stop();
    });

    test("health check returns OK over SSL", async () => {
        const res = await request(app.getHttpServer()).get("/health");
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("ok");
    });
});
