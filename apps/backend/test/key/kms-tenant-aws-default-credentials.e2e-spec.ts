import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INestApplication } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
} from "vitest";
import { AppModule } from "../../src/app.module.js";
import { KmsConfigService } from "../../src/crypto/key/kms/kms-config.service.js";
import { KmsProviderRegistry } from "../../src/crypto/key/kms/kms-provider.registry.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { documentBundle } from "../shared/config-bundle.js";
import { getTenantAdminToken } from "../utils.js";

/**
 * With KMS_TENANT_AWS_DEFAULT_CREDENTIALS, a tenant kms.json may hold an
 * aws-kms provider that uses the AWS identity of the instance, but only the
 * operator adds it, by file. No test calls the provider, so nothing reaches
 * AWS.
 */
describe("Key Chain — tenant aws-kms providers on the instance's AWS identity (e2e)", () => {
    let app: INestApplication;
    let authToken: string;
    let tmpConfigDir: string;
    const TENANT_ID = "kms-aws-default-credentials";
    const AWS = { id: "aws", type: "aws-kms", region: "eu-central-1" };

    const tenantFile = () => join(tmpConfigDir, TENANT_ID, "kms.json");
    const refresh = () => {
        app.get(KmsConfigService).invalidateTenantCache(TENANT_ID);
        app.get(KmsProviderRegistry).invalidateTenant(TENANT_ID);
    };
    const put = (provider: Record<string, unknown>) =>
        request(app.getHttpServer())
            .put("/key-chain/providers/config")
            .set("Authorization", `Bearer ${authToken}`)
            .send({ providers: [provider] });

    beforeAll(async () => {
        tmpConfigDir = mkdtempSync(join(tmpdir(), "eudiplo-kms-aws-test-"));
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [
                ConfigModule.forRoot({
                    isGlobal: true,
                    load: [
                        () => ({
                            CONFIG_FOLDER: tmpConfigDir,
                            KMS_TENANT_AWS_DEFAULT_CREDENTIALS: true,
                        }),
                    ],
                }),
                AppModule,
            ],
        }).compile();

        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(createAppValidationPipe());
        await app.init();

        const configService = app.get(ConfigService);
        authToken = await getTenantAdminToken(
            app,
            configService.getOrThrow<string>("AUTH_CLIENT_ID"),
            configService.getOrThrow<string>("AUTH_CLIENT_SECRET"),
            TENANT_ID,
        );
    });

    beforeEach(() => {
        rmSync(tenantFile(), { force: true });
        refresh();
    });

    afterAll(async () => {
        await app.close();
        rmSync(tmpConfigDir, { recursive: true, force: true });
    });

    test("the API does not add such a provider, also with the setting on", async () => {
        const res = await put(AWS).expect(400);

        expect(res.body.message).toContain(
            "KMS_TENANT_AWS_DEFAULT_CREDENTIALS",
        );
        expect(existsSync(tenantFile())).toBe(false);
        const plan = await request(app.getHttpServer())
            .post("/config-bundles/plan?mode=upsert")
            .set("Authorization", `Bearer ${authToken}`)
            .send(
                documentBundle(TENANT_ID, "KmsConfig", "kms", "kms.json", {
                    providers: [AWS],
                }),
            )
            .expect(201);
        expect(plan.body.applicable).toBe(false);
        expect(plan.body.items[0].issues).toContainEqual(
            expect.objectContaining({ code: "KMS_SETTING_REFUSED" }),
        );
    });

    test("a provider the operator stored loads and is kept, for its region only", async () => {
        mkdirSync(join(tmpConfigDir, TENANT_ID), { recursive: true });
        writeFileSync(tenantFile(), JSON.stringify({ providers: [AWS] }));
        refresh();

        const config = await request(app.getHttpServer())
            .get("/key-chain/providers/config")
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        expect(config.body.effectiveConfig.providers).toContainEqual(
            expect.objectContaining(AWS),
        );
        await put({ ...AWS, description: "kept" }).expect(200);

        await put({ ...AWS, region: "us-east-1" }).expect(400);
        expect(
            JSON.parse(readFileSync(tenantFile(), "utf8")).providers[0],
        ).toMatchObject({ region: "eu-central-1", description: "kept" });
    });
});
