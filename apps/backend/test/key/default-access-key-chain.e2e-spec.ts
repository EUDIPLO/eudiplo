import "reflect-metadata";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { schemaUrl } from "@eudiplo/config-format/config-format.js";
import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { Role } from "../../src/auth/roles/role.enum.js";
import { KeyUsageType } from "../../src/crypto/key/types/key-usage-type.js";
import type {
    ConfigBundle,
    ConfigImportPlan,
    ConfigResourceKind,
} from "../../src/platform/config-portability/config-resource.types.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { getTenantAdminToken } from "../utils.js";
import { createKeyChain } from "../utils-ec.js";

const fixtures = resolve(__dirname, "../fixtures/haip");

/** The spec of a fixture key chain document. */
function fixtureKeyChainSpec(file: string): Record<string, any> {
    return JSON.parse(
        readFileSync(join(fixtures, `key-chains/${file}.json`), "utf8"),
    ).spec;
}

async function createApp(): Promise<INestApplication<App>> {
    const moduleFixture = await Test.createTestingModule({
        imports: [AppModule],
    }).compile();
    const app = moduleFixture.createNestApplication<INestApplication<App>>();
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    return app;
}

function tenantToken(app: INestApplication, tenant: string, roles: Role[]) {
    const config = app.get(ConfigService);
    return getTenantAdminToken(
        app,
        config.getOrThrow<string>("AUTH_CLIENT_ID"),
        config.getOrThrow<string>("AUTH_CLIENT_SECRET"),
        tenant,
        roles,
    );
}

/** Base64 DER of a PEM certificate, as an x5c entry carries it. */
function derOf(pem: string): string {
    return pem
        .replace(/-----(BEGIN|END) CERTIFICATE-----/g, "")
        .replace(/\s/g, "");
}

describe("default access key chain of a tenant", () => {
    const tenant = "default-access-key-chain";
    let app: INestApplication<App>;
    let auth: string;
    let accessKeyChains: string[];
    /** An access key chain the rule does not pick. */
    let chosen: string;
    let attestation: string;
    /** The access key chain picked by rule. */
    let ranked: string;

    const api = () => request(app.getHttpServer());

    /** The leaf certificate that signs the tenant's issuer metadata. */
    async function issuerMetadataSigner(): Promise<string> {
        const response = await api()
            .get(`/.well-known/openid-credential-issuer/issuers/${tenant}`)
            .set("Accept", "application/jwt")
            .expect(200);
        const header = JSON.parse(
            Buffer.from(response.text.split(".")[0], "base64url").toString(),
        );
        return header.x5c[0];
    }

    async function certificateOf(id: string): Promise<string> {
        const response = await api()
            .get(`/key-chain/${id}`)
            .set("Authorization", auth)
            .expect(200);
        return derOf(response.body.activeCertificate.pem);
    }

    beforeAll(async () => {
        app = await createApp();
        const token = await tenantToken(app, tenant, [
            Role.Issuances,
            Role.Presentations,
            Role.Keys,
        ]);
        auth = `Bearer ${token}`;
        accessKeyChains = [
            await createKeyChain(app, token, {
                usageType: KeyUsageType.Access,
                description: "first",
            }),
            await createKeyChain(app, token, {
                usageType: KeyUsageType.Access,
                description: "second",
            }),
        ];
        attestation = await createKeyChain(app, token, {
            usageType: KeyUsageType.Attestation,
            description: "attestation",
        });
        // Signed issuer metadata needs an issuance configuration.
        await api()
            .post("/issuer/config")
            .set("Authorization", auth)
            .send({
                authorizationServers: [{ id: "issuer", type: "built-in" }],
                display: [{ locale: "en-US", name: "Default access" }],
            })
            .expect(201);
    });

    afterAll(async () => {
        await app?.close();
    });

    test("picks the access key chain by rule while none is set", async () => {
        const response = await api()
            .get("/key-chain/access/default")
            .set("Authorization", auth)
            .expect(200);

        // All are self-signed, so creation time and ID decide.
        ranked = response.body.keyChainId;
        expect(response.body).toEqual({ keyChainId: expect.any(String) });
        chosen = accessKeyChains.find((id) => id !== ranked)!;
        expect(await issuerMetadataSigner()).toBe(await certificateOf(ranked));
    });

    test("refuses a key chain of another tenant or usage type", async () => {
        const unknown = await api()
            .put("/key-chain/access/default")
            .set("Authorization", auth)
            .send({ defaultAccessKeyChainId: "missing" })
            .expect(400);
        expect(unknown.body.message).toBe(
            'Key chain "missing" does not exist in this tenant.',
        );

        const wrongUsage = await api()
            .put("/key-chain/access/default")
            .set("Authorization", auth)
            .send({ defaultAccessKeyChainId: attestation })
            .expect(400);
        expect(wrongUsage.body.message).toContain(
            'has usage type "attestation"',
        );
    });

    test("signs with the default access key chain and refuses to delete it", async () => {
        const response = await api()
            .put("/key-chain/access/default")
            .set("Authorization", auth)
            .send({ defaultAccessKeyChainId: chosen })
            .expect(200);
        expect(response.body).toEqual({
            defaultAccessKeyChainId: chosen,
            keyChainId: chosen,
        });
        expect(await issuerMetadataSigner()).toBe(await certificateOf(chosen));

        const refused = await api()
            .delete(`/key-chain/${chosen}`)
            .set("Authorization", auth)
            .expect(409);
        expect(refused.body).toMatchObject({
            code: "KEY_CHAIN_IN_USE",
            references: [{ kind: "Tenant" }],
        });
        expect(refused.body.message).toContain(
            "the tenant's default access key chain setting (defaultAccessKeyChainId)",
        );
    });

    test("exports the default access key chain in info.json", async () => {
        const response = await api()
            .get("/config-bundles/resources/Tenant/tenant/document")
            .set("Authorization", auth)
            .expect(200);

        expect(response.body.$schema).toBe(schemaUrl("Tenant", 2));
        expect(response.body.spec.defaultAccessKeyChainId).toBe(chosen);
    });

    test("goes back to the rule with null", async () => {
        const response = await api()
            .put("/key-chain/access/default")
            .set("Authorization", auth)
            .send({ defaultAccessKeyChainId: null })
            .expect(200);

        expect(response.body).toEqual({ keyChainId: ranked });
        expect(await issuerMetadataSigner()).toBe(await certificateOf(ranked));
    });

    // Last: the new token revokes the one of the other tests.
    test("accepts the same setting through PATCH /tenant/{id}", async () => {
        const root = `Bearer ${await tenantToken(app, tenant, [Role.Tenants])}`;

        await api()
            .patch(`/tenant/${tenant}`)
            .set("Authorization", root)
            .send({ defaultAccessKeyChainId: attestation })
            .expect(400);
        const patched = await api()
            .patch(`/tenant/${tenant}`)
            .set("Authorization", root)
            .send({ defaultAccessKeyChainId: chosen })
            .expect(200);
        expect(patched.body.defaultAccessKeyChainId).toBe(chosen);
    });
});

describe("default access key chain in configuration imports", () => {
    const tenant = "default-access-key-chain-import";
    let app: INestApplication<App>;
    let auth: string;
    let access: string;
    let attestation: string;

    const api = () => request(app.getHttpServer());

    function bundleOf(
        entries: Array<{ kind: ConfigResourceKind; spec: Record<string, any> }>,
    ): ConfigBundle {
        const documents = entries.map(({ kind, spec }) => ({
            $schema: schemaUrl(kind),
            metadata: { generation: 1 },
            spec,
        }));
        return {
            manifest: {
                format: "eudiplo.config-bundle",
                formatVersion: 2,
                sourceVersion: "default-access-key-chain-import",
                exportedAt: new Date(0).toISOString(),
                tenant,
                resources: entries.map(({ kind, spec }, index) => ({
                    kind,
                    id: kind === "Tenant" ? "tenant" : spec.id,
                    $schema: documents[index].$schema,
                    path:
                        kind === "Tenant"
                            ? "info.json"
                            : `${kind}/${spec.id}.json`,
                    sha256: createHash("sha256")
                        .update(JSON.stringify(documents[index]))
                        .digest("hex"),
                    ownership: "unmanaged",
                    generation: 1,
                })),
                assets: [],
                requirements: [],
                warnings: [],
            },
            documents,
            assets: [],
        } as unknown as ConfigBundle;
    }

    async function plan(bundle: ConfigBundle): Promise<ConfigImportPlan> {
        const response = await api()
            .post("/config-bundles/plan?mode=upsert")
            .set("Authorization", auth)
            .send(bundle)
            .expect(201);
        return response.body;
    }

    const tenantSpec = (defaultAccessKeyChainId?: string) => ({
        name: tenant,
        ...(defaultAccessKeyChainId ? { defaultAccessKeyChainId } : {}),
    });

    beforeAll(async () => {
        app = await createApp();
        // Bundle imports need tenant:admin.
        const token = await tenantToken(app, tenant, [
            Role.TenantAdmin,
            Role.Keys,
        ]);
        auth = `Bearer ${token}`;
        access = await createKeyChain(app, token, {
            usageType: KeyUsageType.Access,
        });
        attestation = await createKeyChain(app, token, {
            usageType: KeyUsageType.Attestation,
        });
    });

    afterAll(async () => {
        await app?.close();
    });

    test("blocks a default access key chain that does not exist or has another usage type", async () => {
        const missing = await plan(
            bundleOf([{ kind: "Tenant", spec: tenantSpec("missing") }]),
        );
        expect(missing.applicable).toBe(false);
        expect(missing.issues).toContainEqual(
            expect.objectContaining({
                code: "MISSING_RESOURCE_REFERENCE",
                path: "/spec/defaultAccessKeyChainId",
            }),
        );

        const wrongUsage = await plan(
            bundleOf([{ kind: "Tenant", spec: tenantSpec(attestation) }]),
        );
        expect(wrongUsage.applicable).toBe(false);
        expect(wrongUsage.issues).toContainEqual(
            expect.objectContaining({
                code: "KEY_CHAIN_USAGE_MISMATCH",
                path: "/spec/defaultAccessKeyChainId",
            }),
        );
    });

    test("sets the default from info.json and removes it when the file leaves it out", async () => {
        const named = bundleOf([{ kind: "Tenant", spec: tenantSpec(access) }]);
        const namedPlan = await plan(named);
        expect(namedPlan.applicable, JSON.stringify(namedPlan)).toBe(true);
        await api()
            .post(
                `/config-bundles/import?mode=upsert&planFingerprint=${namedPlan.planFingerprint}`,
            )
            .set("Authorization", auth)
            .send(named)
            .expect(201);
        const set = await api()
            .get("/key-chain/access/default")
            .set("Authorization", auth)
            .expect(200);
        expect(set.body.defaultAccessKeyChainId).toBe(access);

        const omitted = bundleOf([{ kind: "Tenant", spec: tenantSpec() }]);
        const omittedPlan = await plan(omitted);
        expect(omittedPlan.applicable, JSON.stringify(omittedPlan)).toBe(true);
        await api()
            .post(
                `/config-bundles/import?mode=upsert&planFingerprint=${omittedPlan.planFingerprint}`,
            )
            .set("Authorization", auth)
            .send(omitted)
            .expect(201);
        const removed = await api()
            .get("/key-chain/access/default")
            .set("Authorization", auth)
            .expect(200);
        expect(removed.body).not.toHaveProperty("defaultAccessKeyChainId");
    });
});

describe("default access key chain in replace imports", () => {
    const tenant = "default-access-key-chain-replace";
    const accessKeyChain = fixtureKeyChainSpec("access");
    const attestationKeyChain = fixtureKeyChainSpec("attestation");
    let app: INestApplication<App>;
    let auth: string;

    const api = () => request(app.getHttpServer());

    function bundleOf(
        entries: Array<{ kind: ConfigResourceKind; spec: Record<string, any> }>,
    ): ConfigBundle {
        const documents = entries.map(({ kind, spec }) => ({
            $schema: schemaUrl(kind),
            metadata: { generation: 1 },
            spec,
        }));
        return {
            manifest: {
                format: "eudiplo.config-bundle",
                formatVersion: 2,
                sourceVersion: tenant,
                exportedAt: new Date(0).toISOString(),
                tenant,
                resources: entries.map(({ kind, spec }, index) => ({
                    kind,
                    id: kind === "Tenant" ? "tenant" : spec.id,
                    $schema: documents[index].$schema,
                    path:
                        kind === "Tenant"
                            ? "info.json"
                            : `${kind}/${spec.id}.json`,
                    sha256: createHash("sha256")
                        .update(JSON.stringify(documents[index]))
                        .digest("hex"),
                    ownership: "unmanaged",
                    generation: 1,
                })),
                assets: [],
                requirements: [],
                warnings: [],
            },
            documents,
            assets: [],
        } as unknown as ConfigBundle;
    }

    async function plan(
        bundle: ConfigBundle,
        mode: "upsert" | "replace",
    ): Promise<ConfigImportPlan> {
        const response = await api()
            .post(`/config-bundles/plan?mode=${mode}`)
            .set("Authorization", auth)
            .send(bundle)
            .expect(201);
        return response.body;
    }

    const keyChainItem = (result: ConfigImportPlan) =>
        result.items.find(
            (item) => item.kind === "KeyChain" && item.id === accessKeyChain.id,
        );

    beforeAll(async () => {
        app = await createApp();
        auth = `Bearer ${await tenantToken(app, tenant, [
            Role.TenantAdmin,
            Role.Keys,
        ])}`;
    });

    afterAll(async () => {
        await app?.close();
    });

    test("checks the usage type of a key chain that comes in the same bundle", async () => {
        const wrongUsage = await plan(
            bundleOf([
                { kind: "KeyChain", spec: attestationKeyChain },
                {
                    kind: "Tenant",
                    spec: {
                        name: tenant,
                        defaultAccessKeyChainId: attestationKeyChain.id,
                    },
                },
            ]),
            "upsert",
        );
        expect(wrongUsage.applicable).toBe(false);
        expect(wrongUsage.issues).toContainEqual(
            expect.objectContaining({ code: "KEY_CHAIN_USAGE_MISMATCH" }),
        );
    });

    test("blocks deleting the default and allows it once the bundle drops the setting", async () => {
        const named = bundleOf([
            { kind: "KeyChain", spec: accessKeyChain },
            {
                kind: "Tenant",
                spec: {
                    name: tenant,
                    defaultAccessKeyChainId: accessKeyChain.id,
                },
            },
        ]);
        const namedPlan = await plan(named, "upsert");
        expect(namedPlan.applicable, JSON.stringify(namedPlan)).toBe(true);
        await api()
            .post(
                `/config-bundles/import?mode=upsert&planFingerprint=${namedPlan.planFingerprint}`,
            )
            .set("Authorization", auth)
            .send(named)
            .expect(201);

        // The stored tenant still names the key chain the bundle leaves out.
        const blocked = await plan(
            bundleOf([{ kind: "KeyChain", spec: attestationKeyChain }]),
            "replace",
        );
        expect(blocked.applicable).toBe(false);
        expect(keyChainItem(blocked)).toMatchObject({ action: "blocked" });
        expect(keyChainItem(blocked)?.issues).toContainEqual(
            expect.objectContaining({
                code: "KEY_CHAIN_IN_USE",
                message: expect.stringContaining(
                    "the tenant's default access key chain setting",
                ),
            }),
        );

        // The same import with an info.json without the setting removes it first.
        const dropped = await plan(
            bundleOf([
                { kind: "KeyChain", spec: attestationKeyChain },
                { kind: "Tenant", spec: { name: tenant } },
            ]),
            "replace",
        );
        expect(dropped.applicable, JSON.stringify(dropped)).toBe(true);
        expect(keyChainItem(dropped)).toMatchObject({ action: "delete" });
    });
});

describe("default access key chain roles", () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
        app = await createApp();
    });

    afterAll(async () => {
        await app?.close();
    });

    test("refuses callers without a key chain management role", async () => {
        const auth = `Bearer ${await tenantToken(
            app,
            "default-access-key-chain-roles",
            [Role.PresentationRequest, Role.Clients],
        )}`;

        await request(app.getHttpServer())
            .get("/key-chain/access/default")
            .set("Authorization", auth)
            .expect(403);
        await request(app.getHttpServer())
            .put("/key-chain/access/default")
            .set("Authorization", auth)
            .send({ defaultAccessKeyChainId: null })
            .expect(403);
    });
});
