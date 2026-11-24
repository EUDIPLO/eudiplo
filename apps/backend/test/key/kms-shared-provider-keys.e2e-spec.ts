import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INestApplication } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { KeyChainType } from "../../src/crypto/key/dto/key-chain-create.dto.js";
import type {
    ConfigBundle,
    ConfigDocument,
} from "../../src/platform/config-portability/config-resource.types.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { documentBundle, documentsBundle } from "../shared/config-bundle.js";
import { mockKms, startKmsServer } from "../shared/http-kms-mock.js";
import { getTenantAdminToken } from "../utils.js";

/**
 * Two tenants use the `shared` provider of the global kms.json. A key chain
 * names its key by provider ID and key name, so neither tenant may choose
 * that pair freely on the shared provider.
 */
describe("Key Chain — keys of a KMS provider that tenants share (e2e)", () => {
    const SHARED = "shared";
    const OWNER = "kms-shared-owner";
    const OTHER = "kms-shared-other";
    let app: INestApplication;
    let sharedKms: Awaited<ReturnType<typeof startKmsServer>>;
    let ownKms: Awaited<ReturnType<typeof startKmsServer>>;
    let tmpConfigDir: string;
    let ownerToken: string;
    let otherToken: string;
    /** The owner's key chain on the shared provider, as its export holds it. */
    let ownerKeyChain: ConfigDocument;
    let ownerKeyChainId: string;

    const api = (token: string) => {
        const server = request(app.getHttpServer());
        const auth = { Authorization: `Bearer ${token}` };
        return {
            get: (path: string) => server.get(path).set(auth),
            post: (path: string) => server.post(path).set(auth),
            put: (path: string) => server.put(path).set(auth),
            delete: (path: string) => server.delete(path).set(auth),
        };
    };
    /** A bundle with the owner's key chain document under `id`. */
    const keyChainBundle = (tenant: string, id: string): ConfigBundle =>
        documentBundle(tenant, "KeyChain", id, `key-chains/${id}.json`, {
            ...(ownerKeyChain.spec as Record<string, unknown>),
            id,
        });
    const createKeyChain = (token: string) =>
        api(token)
            .post("/key-chain")
            .send({
                type: KeyChainType.Standalone,
                usageType: "access",
                kmsProvider: SHARED,
            })
            .expect(201)
            .then((res) => res.body.id as string);
    const importBundle = (
        token: string,
        bundle: ConfigBundle,
        planFingerprint: string,
    ) =>
        api(token)
            .post(
                `/config-bundles/import?mode=upsert&planFingerprint=${planFingerprint}`,
            )
            .send(bundle);
    const ownerKeyId = (): string =>
        (ownerKeyChain.spec as Record<string, any>).keySource.externalKeyId;
    /**
     * The shared KMS still holds the owner's key under its name. Read from
     * the KMS itself: a plan of a key chain that did not change skips the
     * challenge signature, so it would not notice a replaced key.
     */
    const expectOwnerKeyUnchanged = async () => {
        const { kty, crv, x, y } = (ownerKeyChain.spec as Record<string, any>)
            .keySource.publicJwk;
        expect(await sharedKms.publicJwk(ownerKeyId())).toEqual({
            kty,
            crv,
            x,
            y,
        });
        const plan = await api(ownerToken)
            .post("/config-bundles/plan?mode=upsert")
            .send(keyChainBundle(OWNER, ownerKeyChainId))
            .expect(201);
        expect(plan.body.issues).toEqual([]);
    };
    /** A bundle that gives OTHER its own `shared` provider and a key chain on it. */
    const ownProviderBundle = (id: string, keySource: unknown) =>
        documentsBundle(OTHER, [
            {
                kind: "KmsConfig",
                id: "kms",
                path: "kms.json",
                spec: { providers: [ownProvider()] },
            },
            {
                kind: "KeyChain",
                id,
                path: `key-chains/${id}.json`,
                spec: {
                    ...(ownerKeyChain.spec as Record<string, unknown>),
                    id,
                    keySource,
                },
            },
        ]);
    const ownProvider = () => ({
        id: SHARED,
        type: "http",
        baseUrl: ownKms.baseUrl,
    });

    beforeAll(async () => {
        sharedKms = await startKmsServer();
        ownKms = await startKmsServer();
        tmpConfigDir = mkdtempSync(join(tmpdir(), "eudiplo-kms-shared-test-"));
        writeFileSync(
            join(tmpConfigDir, "kms.json"),
            JSON.stringify({
                providers: [
                    { id: "db", type: "db" },
                    {
                        id: SHARED,
                        type: "http",
                        baseUrl: sharedKms.baseUrl,
                        canImport: true,
                    },
                ],
            }),
        );
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [
                ConfigModule.forRoot({
                    isGlobal: true,
                    load: [() => ({ CONFIG_FOLDER: tmpConfigDir })],
                }),
                AppModule,
            ],
        }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(createAppValidationPipe());
        await app.init();

        const configService = app.get(ConfigService);
        const clientId = configService.getOrThrow<string>("AUTH_CLIENT_ID");
        const clientSecret =
            configService.getOrThrow<string>("AUTH_CLIENT_SECRET");
        ownerToken = await getTenantAdminToken(
            app,
            clientId,
            clientSecret,
            OWNER,
        );
        otherToken = await getTenantAdminToken(
            app,
            clientId,
            clientSecret,
            OTHER,
        );

        ownerKeyChainId = await createKeyChain(ownerToken);
        const exported = await api(ownerToken)
            .get("/config-bundles/export")
            .expect(200);
        const bundle = exported.body as ConfigBundle;
        const index = bundle.manifest.resources.findIndex(
            (resource) =>
                resource.kind === "KeyChain" && resource.id === ownerKeyChainId,
        );
        ownerKeyChain = bundle.documents[index] as ConfigDocument;
        expect(
            (ownerKeyChain.spec as { keySource: { type: string } }).keySource
                .type,
        ).toBe("external-reference");
    });

    afterAll(async () => {
        await app?.close();
        for (const kms of [sharedKms, ownKms]) {
            await new Promise<void>((resolve) =>
                kms.server.close(() => resolve()),
            );
        }
        rmSync(tmpConfigDir, { recursive: true, force: true });
    });

    test("a tenant cannot attach a key of another tenant on the shared provider", async () => {
        const bundle = keyChainBundle(OTHER, "stolen");
        const signsBefore = mockKms.signCount;

        const plan = await api(otherToken)
            .post("/config-bundles/plan?mode=upsert")
            .send(bundle)
            .expect(201);

        expect(plan.body.applicable).toBe(false);
        expect(plan.body.issues).toContainEqual(
            expect.objectContaining({
                code: "KMS_REFERENCE_REFUSED",
                severity: "error",
                resource: { kind: "KeyChain", id: "stolen" },
            }),
        );
        await api(otherToken)
            .post(
                `/config-bundles/import?mode=upsert&planFingerprint=${plan.body.planFingerprint}`,
            )
            .send(bundle)
            .expect(400);
        // The key did not sign a preflight challenge for the other tenant.
        expect(mockKms.signCount).toBe(signsBefore);
        const keyChains = await api(otherToken).get("/key-chain").expect(200);
        expect(keyChains.body).toEqual([]);
    });

    test("a tenant can import a key chain again that names a key it holds", async () => {
        const bundle = keyChainBundle(OWNER, ownerKeyChainId);
        const plan = await api(ownerToken)
            .post("/config-bundles/plan?mode=upsert")
            .send(bundle)
            .expect(201);

        expect(plan.body.issues).not.toContainEqual(
            expect.objectContaining({ code: "KMS_REFERENCE_REFUSED" }),
        );
        expect(plan.body.applicable).toBe(true);
        await importBundle(
            ownerToken,
            bundle,
            plan.body.planFingerprint,
        ).expect(201);
    });

    test("an import of a private key does not choose the key's name on the shared provider", async () => {
        const privateJwk = generateKeyPairSync("ec", {
            namedCurve: "P-256",
        }).privateKey.export({ format: "jwk" });

        const imported = await api(otherToken)
            .post("/key-chain/import")
            .send({
                key: { ...privateJwk, kid: ownerKeyId() },
                usageType: "access",
                kmsProvider: SHARED,
            })
            .expect(201);

        expect(
            sharedKms.keyIds().filter((id) => id === ownerKeyId()),
        ).toHaveLength(1);
        expect(sharedKms.keyIds()).toContainEqual(
            expect.stringContaining(`${imported.body.id}-import-`),
        );
        await expectOwnerKeyUnchanged();
        await api(otherToken)
            .delete(`/key-chain/${imported.body.id}`)
            .expect(204);
        await expectOwnerKeyUnchanged();
    });

    test("a tenant can attach any key of a provider it holds the credentials of", async () => {
        const created = await fetch(`${ownKms.baseUrl}/keys`, {
            method: "POST",
            body: JSON.stringify({ kid: "brought-along", alg: "ES256" }),
        });
        const { publicJwk } = (await created.json()) as {
            publicJwk: Record<string, unknown>;
        };
        const bundle = ownProviderBundle("brought-along", {
            type: "external-reference",
            provider: SHARED,
            externalKeyId: "brought-along",
            publicJwk,
        });

        const plan = await api(otherToken)
            .post("/config-bundles/plan?mode=upsert")
            .send(bundle)
            .expect(201);

        expect(plan.body.issues).toEqual([
            expect.objectContaining({ code: "KMS_PREFLIGHT_DEFERRED" }),
        ]);
        expect(plan.body.applicable).toBe(true);
        await importBundle(
            otherToken,
            bundle,
            plan.body.planFingerprint,
        ).expect(201);
        const keyChain = await api(otherToken)
            .get("/key-chain/brought-along")
            .expect(200);
        expect(keyChain.body.kmsProvider).toBe(SHARED);
        // An imported resource is managed by its bundle until detached.
        for (const resource of ["KeyChain/brought-along", "KmsConfig/kms"]) {
            await api(otherToken)
                .post(`/config-bundles/resources/${resource}/detach`)
                .expect(201);
        }
        await api(otherToken).delete("/key-chain/brought-along").expect(204);
        await api(otherToken).delete("/key-chain/providers/config").expect(204);
    });

    test("a plan does not sign with a shared key for a provider the bundle would make the tenant's own", async () => {
        const source = (ownerKeyChain.spec as Record<string, any>).keySource;
        const signsBefore = mockKms.signCount;

        const plan = await api(otherToken)
            .post("/config-bundles/plan?mode=upsert")
            .send(ownProviderBundle("probe", source))
            .expect(201);

        expect(plan.body.issues).toEqual([
            expect.objectContaining({ code: "KMS_PREFLIGHT_DEFERRED" }),
        ]);
        expect(mockKms.signCount).toBe(signsBefore);
    });

    test("a tenant's own provider cannot give way to the shared one under its key chains", async () => {
        const inUse = expect.objectContaining({ code: "KMS_PROVIDER_IN_USE" });
        const kmsBundle = (providers: unknown[], generation: number) =>
            documentBundle(
                OTHER,
                "KmsConfig",
                "kms",
                "kms.json",
                { providers },
                generation,
            );
        const own = kmsBundle([ownProvider()], 20);
        const ownPlan = await api(otherToken)
            .post("/config-bundles/plan?mode=upsert")
            .send(own)
            .expect(201);
        await importBundle(
            otherToken,
            own,
            ownPlan.body.planFingerprint,
        ).expect(201);
        const keyChainId = await createKeyChain(otherToken);
        expect(ownKms.keyIds()).toContain(`${keyChainId}-active`);

        const plan = await api(otherToken)
            .post("/config-bundles/plan?mode=upsert")
            .send(kmsBundle([], 21))
            .expect(201);
        expect(plan.body.applicable).toBe(false);
        expect(plan.body.issues).toContainEqual(inUse);
        // A replace that leaves the file out would delete it.
        const replace = await api(otherToken)
            .post("/config-bundles/plan?mode=replace")
            .send(documentsBundle(OTHER, []))
            .expect(201);
        expect(replace.body.items).toContainEqual(
            expect.objectContaining({ kind: "KmsConfig", action: "blocked" }),
        );
        expect(replace.body.issues).toContainEqual(inUse);

        await api(otherToken)
            .post("/config-bundles/resources/KmsConfig/kms/detach")
            .expect(201);
        const refused = await api(otherToken)
            .delete("/key-chain/providers/config")
            .expect(409);
        expect(refused.body.message).toContain(keyChainId);
        await api(otherToken)
            .put("/key-chain/providers/config")
            .send({ providers: [] })
            .expect(409);
        // Pointing the provider at another server of its own is no hand-over.
        await api(otherToken)
            .put("/key-chain/providers/config")
            .send({
                providers: [{ ...ownProvider(), description: "still own" }],
            })
            .expect(200);

        await api(otherToken).delete(`/key-chain/${keyChainId}`).expect(204);
        await api(otherToken).delete("/key-chain/providers/config").expect(204);
    });

    test("a key chain file of the tenant's folder may name any key of the shared provider", async () => {
        const created = await fetch(`${sharedKms.baseUrl}/keys`, {
            method: "POST",
            body: JSON.stringify({ kid: "operator-made", alg: "ES256" }),
        });
        const { publicJwk } = (await created.json()) as {
            publicJwk: Record<string, unknown>;
        };
        const folder = join(tmpConfigDir, OTHER, "key-chains");
        mkdirSync(folder, { recursive: true });
        writeFileSync(
            join(folder, "operator-made.json"),
            JSON.stringify({
                $schema: ownerKeyChain.$schema,
                metadata: { generation: 1 },
                spec: {
                    id: "operator-made",
                    type: "standalone",
                    usageType: "access",
                    keySource: {
                        type: "external-reference",
                        provider: SHARED,
                        externalKeyId: "operator-made",
                        publicJwk,
                    },
                    crt: (ownerKeyChain.spec as { crt: string[] }).crt,
                },
            }),
        );

        const plan = await api(otherToken)
            .post(
                "/config-bundles/resources/KeyChain/operator-made/reattach/plan",
            )
            .expect(201);
        expect(plan.body.issues).toEqual([]);
        await api(otherToken)
            .post(
                `/config-bundles/resources/KeyChain/operator-made/reattach?planFingerprint=${plan.body.planFingerprint}`,
            )
            .expect(201);

        const keyChain = await api(otherToken)
            .get("/key-chain/operator-made")
            .expect(200);
        expect(keyChain.body.kmsProvider).toBe(SHARED);
    });

    test("a tenant file another backend process wrote is used without a restart", async () => {
        // As a second replica on the same CONFIG_FOLDER would write it: this
        // process is not told.
        const tenantFile = join(tmpConfigDir, OTHER, "kms.json");
        const sharedBefore = sharedKms.keyIds();
        const importKey = (kid: string) =>
            api(otherToken)
                .post("/key-chain/import")
                .send({
                    key: {
                        ...generateKeyPairSync("ec", {
                            namedCurve: "P-256",
                        }).privateKey.export({ format: "jwk" }),
                        kid,
                    },
                    usageType: "access",
                    kmsProvider: SHARED,
                })
                .expect(201)
                .then((res) => res.body.id as string);
        const operationIds = async () =>
            (
                await api(otherToken)
                    .get("/config-bundles/operations")
                    .expect(200)
            ).body.map((run: { id: string }) => run.id) as string[];
        mkdirSync(join(tmpConfigDir, OTHER), { recursive: true });
        writeFileSync(
            tenantFile,
            JSON.stringify({
                providers: [{ ...ownProvider(), canImport: true }],
            }),
        );
        try {
            const keyChainId = await createKeyChain(otherToken);
            const before = await operationIds();
            // The provider is the tenant's own now, so its key name is kept.
            const ownImport = await importKey("chosen-on-own");

            expect(ownKms.keyIds()).toContain(`${keyChainId}-active`);
            expect(ownKms.keyIds()).toContain("chosen-on-own");
            expect(sharedKms.keyIds()).toEqual(sharedBefore);
            // The import ran as the tenant's configuration writer.
            const operations = await api(otherToken)
                .get("/config-bundles/operations")
                .expect(200);
            expect(
                operations.body.filter(
                    (run: { id: string }) => !before.includes(run.id),
                ),
            ).toEqual([
                expect.objectContaining({
                    mode: "api",
                    status: "completed",
                    operations: [{ stage: "resource", status: "completed" }],
                }),
            ]);
            for (const id of [keyChainId, ownImport]) {
                await api(otherToken).delete(`/key-chain/${id}`).expect(204);
            }
        } finally {
            rmSync(tenantFile);
        }

        // And the other way round: without the file, the ID names the
        // global provider again, where a request does not choose key names.
        const onShared = await createKeyChain(otherToken);
        const sharedImport = await importKey("chosen-on-shared");
        expect(sharedKms.keyIds()).toContain(`${onShared}-active`);
        expect(sharedKms.keyIds()).not.toContain("chosen-on-shared");
        expect(sharedKms.keyIds()).toContainEqual(
            expect.stringContaining(`${sharedImport}-import-`),
        );
        for (const id of [onShared, sharedImport]) {
            await api(otherToken).delete(`/key-chain/${id}`).expect(204);
        }
    });

    test("a tenant cannot name a KMS service of the backend's network as a provider of its own", async () => {
        const configService = app.get(ConfigService);
        const stored = await api(otherToken)
            .get("/key-chain/providers/config")
            .expect(200);
        const allowed = configService.get("OUTBOUND_URL_ALLOW_PRIVATE_NETWORK");
        configService.set("OUTBOUND_URL_ALLOW_PRIVATE_NETWORK", "false");
        try {
            // The server of the global provider, which authenticates nobody.
            const providers = [
                { id: "mine", type: "http", baseUrl: sharedKms.baseUrl },
            ];
            const res = await api(otherToken)
                .put("/key-chain/providers/config")
                .send({ providers })
                .expect(400);
            expect(res.body.message).toContain("outbound URL policy");
            const plan = await api(otherToken)
                .post("/config-bundles/plan?mode=upsert")
                .send(
                    documentsBundle(OTHER, [
                        {
                            kind: "KmsConfig",
                            id: "kms",
                            path: "kms.json",
                            spec: { providers },
                        },
                    ]),
                )
                .expect(201);
            expect(plan.body.applicable).toBe(false);
            expect(plan.body.issues).toContainEqual(
                expect.objectContaining({ code: "KMS_SETTING_REFUSED" }),
            );
            // The global provider on the same server stays in use.
            const health = await api(ownerToken)
                .get("/key-chain/providers/health")
                .expect(200);
            expect(health.body).toContainEqual(
                expect.objectContaining({ providerId: SHARED, ok: true }),
            );
        } finally {
            configService.set("OUTBOUND_URL_ALLOW_PRIVATE_NETWORK", allowed);
        }
        const after = await api(otherToken)
            .get("/key-chain/providers/config")
            .expect(200);
        expect(after.body.tenantConfig).toEqual(stored.body.tenantConfig);
    });

    test("the owner's key is untouched", async () => {
        await expectOwnerKeyUnchanged();
        const keyChain = await api(ownerToken)
            .get(`/key-chain/${ownerKeyChainId}`)
            .expect(200);
        expect(keyChain.body.kmsProvider).toBe(SHARED);
    });
});
