import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { Role } from "../../src/auth/roles/role.enum.js";
import { KeyChainType } from "../../src/crypto/key/dto/key-chain-create.dto.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { mockKms, startKmsServer } from "../shared/http-kms-mock.js";
import { getToken } from "../utils.js";

/**
 * A tenant that writes its own kms.json through the API chooses both the
 * secret reference of a credential and the server it is sent to. The
 * policy decides which references it may name: only those in its own
 * namespace (here env variables starting with E2E_KMS_), so it cannot send
 * a secret of the instance or of another tenant to a server of its choice.
 */
describe("Secret references in a tenant kms.json", () => {
    const tenantId = "kmsrefs";
    let app: INestApplication;
    let kmsServer: Server;
    let baseUrl: string;
    let configFolder: string;
    let authorization: string;
    const variables = {
        E2E_KMS_TOKEN: "kms-bearer-from-env",
        OTHER_KMS_TOKEN: "not-granted-do-not-send",
    };
    const before = Object.fromEntries(
        Object.keys(variables).map((key) => [key, process.env[key]]),
    );

    const provider = (token: string) => ({
        id: "own-kms",
        type: "http",
        baseUrl,
        auth: { type: "bearer", token },
        algorithms: ["ES256"],
    });
    const putConfig = (token: string) =>
        request(app.getHttpServer())
            .put("/key-chain/providers/config")
            .set("Authorization", authorization)
            .send({
                defaultProvider: "db",
                providers: [{ id: "db", type: "db" }, provider(token)],
            });
    const createKeyChain = () =>
        request(app.getHttpServer())
            .post("/key-chain")
            .set("Authorization", authorization)
            .send({
                type: KeyChainType.Standalone,
                usageType: "attestation",
                kmsProvider: "own-kms",
                description: "Key in the tenant's KMS",
            });

    beforeAll(async () => {
        ({ server: kmsServer, baseUrl } = await startKmsServer());
        configFolder = mkdtempSync(join(tmpdir(), "eudiplo-kms-refs-"));
        const policyFile = join(configFolder, "secret-policy.json");
        writeFileSync(
            policyFile,
            JSON.stringify({ tenants: { [tenantId]: { env: ["E2E_KMS_*"] } } }),
        );
        Object.assign(process.env, variables);

        const moduleFixture = await Test.createTestingModule({
            imports: [
                ConfigModule.forRoot({
                    isGlobal: true,
                    load: [
                        () => ({
                            CONFIG_FOLDER: configFolder,
                            SECRET_POLICY_FILE: policyFile,
                        }),
                    ],
                }),
                AppModule,
            ],
        }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(createAppValidationPipe());
        await app.init();

        const config = app.get(ConfigService);
        authorization = `Bearer ${await getToken(
            app,
            config.getOrThrow<string>("AUTH_CLIENT_ID"),
            config.getOrThrow<string>("AUTH_CLIENT_SECRET"),
            tenantId,
            [Role.TenantAdmin, Role.Keys],
        )}`;
    });

    afterAll(async () => {
        await app?.close();
        await new Promise<void>((resolve) => kmsServer?.close(() => resolve()));
        rmSync(configFolder, { recursive: true, force: true });
        for (const [key, value] of Object.entries(before)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    it("refuses a reference outside the tenant's namespace, and EUDIPLO's own settings", async () => {
        for (const name of ["OTHER_KMS_TOKEN", "AUTH_CLIENT_SECRET"]) {
            const response = await putConfig(`\${env:${name}}`).expect(400);
            expect(JSON.stringify(response.body)).toContain(
                "providers[1] ('own-kms').auth.token",
            );
            expect(JSON.stringify(response.body)).not.toContain(
                variables.OTHER_KMS_TOKEN,
            );
        }
    });

    it("sends the value of a granted reference to the tenant's KMS, and shows the reference", async () => {
        const reference = "${env:E2E_KMS_TOKEN}";
        const stored = await putConfig(reference).expect(200);
        expect(stored.body.tenantConfig.providers[1].auth.token).toBe(
            reference,
        );

        mockKms.lastAuthorization = undefined;
        await createKeyChain().expect(201);
        expect(mockKms.lastAuthorization).toBe(
            `Bearer ${variables.E2E_KMS_TOKEN}`,
        );
    });

    it("refuses at use a reference outside the namespace that a file names", async () => {
        // The operator's file is not checked like an API write, so the
        // policy is checked again when the credential is used.
        const folder = join(configFolder, tenantId);
        mkdirSync(folder, { recursive: true });
        writeFileSync(
            join(folder, "kms.json"),
            JSON.stringify({
                providers: [
                    { id: "db", type: "db" },
                    provider("${env:OTHER_KMS_TOKEN}"),
                ],
            }),
        );
        mockKms.lastAuthorization = undefined;

        const response = await createKeyChain();

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(mockKms.lastAuthorization).toBeUndefined();
        expect(JSON.stringify(response.body)).not.toContain(
            variables.OTHER_KMS_TOKEN,
        );
    });
});
