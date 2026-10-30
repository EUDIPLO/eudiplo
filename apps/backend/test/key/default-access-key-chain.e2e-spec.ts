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

/** IDs and bundle paths of the singleton kinds these tests import. */
const SINGLETONS: Partial<
    Record<ConfigResourceKind, { id: string; path: string }>
> = {
    Tenant: { id: "tenant", path: "info.json" },
    KeyChainDefaults: { id: "defaults", path: "key-chain-defaults.json" },
    IssuanceConfig: { id: "issuance", path: "issuance/issuance.json" },
};

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
            references: [{ kind: "KeyChainDefaults" }],
        });
        expect(refused.body.message).toContain(
            "the tenant's key chain defaults",
        );
    });

    test("exports the default access key chain as the key chain defaults, not in info.json", async () => {
        const response = await api()
            .get("/config-bundles/resources/KeyChainDefaults/defaults/document")
            .set("Authorization", auth)
            .expect(200);
        expect(response.body).toEqual({
            $schema: schemaUrl("KeyChainDefaults"),
            metadata: expect.any(Object),
            spec: { access: chosen },
        });
        // Changed through the API, so not managed by a file.
        const ownership = await api()
            .get("/config-bundles/resources/KeyChainDefaults")
            .set("Authorization", auth)
            .expect(200);
        expect(ownership.body).toEqual([
            expect.objectContaining({
                resourceId: "defaults",
                ownership: "unmanaged",
            }),
        ]);

        const tenantDocument = await api()
            .get("/config-bundles/resources/Tenant/tenant/document")
            .set("Authorization", auth)
            .expect(200);
        expect(tenantDocument.body.$schema).toBe(schemaUrl("Tenant"));
        expect(tenantDocument.body.spec).not.toHaveProperty("defaultKeyChains");
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
    test("refuses the setting through PATCH /tenant/{id}", async () => {
        const root = `Bearer ${await tenantToken(app, tenant, [Role.Tenants])}`;

        await api()
            .patch(`/tenant/${tenant}`)
            .set("Authorization", root)
            .send({ defaultKeyChains: { access: chosen } })
            .expect(400);
    });
});

describe("default access key chain in configuration imports", () => {
    const tenant = "default-access-key-chain-import";
    let app: INestApplication<App>;
    let auth: string;
    let access: string;
    let attestation: string;
    let accessToken: string;

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
                    id: SINGLETONS[kind]?.id ?? spec.id,
                    $schema: documents[index].$schema,
                    path: SINGLETONS[kind]?.path ?? `${kind}/${spec.id}.json`,
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

    const defaults = (access?: string) => ({
        kind: "KeyChainDefaults" as const,
        spec: access ? { access } : {},
    });

    async function importBundle(bundle: ConfigBundle): Promise<void> {
        const result = await plan(bundle);
        expect(result.applicable, JSON.stringify(result)).toBe(true);
        await api()
            .post(
                `/config-bundles/import?mode=upsert&planFingerprint=${result.planFingerprint}`,
            )
            .set("Authorization", auth)
            .send(bundle)
            .expect(201);
    }

    async function storedDefault(): Promise<string | undefined> {
        const response = await api()
            .get("/key-chain/access/default")
            .set("Authorization", auth)
            .expect(200);
        return response.body.defaultAccessKeyChainId;
    }

    beforeAll(async () => {
        app = await createApp();
        // Bundle imports need tenant:admin.
        const token = await tenantToken(app, tenant, [
            Role.TenantAdmin,
            Role.Keys,
            Role.Issuances,
        ]);
        auth = `Bearer ${token}`;
        access = await createKeyChain(app, token, {
            usageType: KeyUsageType.Access,
        });
        attestation = await createKeyChain(app, token, {
            usageType: KeyUsageType.Attestation,
        });
        accessToken = await createKeyChain(app, token, {
            usageType: KeyUsageType.AccessToken,
        });
    });

    afterAll(async () => {
        await app?.close();
    });

    test("exports an empty key chain defaults document while none is set, and leaves it out of bundles", async () => {
        const document = await api()
            .get("/config-bundles/resources/KeyChainDefaults/defaults/document")
            .set("Authorization", auth)
            .expect(200);
        expect(document.body.spec).toEqual({});

        const exported = await api()
            .get("/config-bundles/export")
            .set("Authorization", auth)
            .expect(200);
        expect(
            (exported.body as ConfigBundle).manifest.resources.map(
                (resource) => resource.kind,
            ),
        ).not.toContain("KeyChainDefaults");
    });

    test("blocks a default access key chain that does not exist or has another usage type", async () => {
        const missing = await plan(bundleOf([defaults("missing")]));
        expect(missing.applicable).toBe(false);
        expect(missing.issues).toContainEqual(
            expect.objectContaining({
                code: "MISSING_RESOURCE_REFERENCE",
                path: "/spec/access",
                resource: { kind: "KeyChainDefaults", id: "defaults" },
            }),
        );

        for (const spec of [{ signing: access }, { access: "" }]) {
            const malformed = await plan(
                bundleOf([{ kind: "KeyChainDefaults", spec }]),
            );
            expect(malformed.applicable, JSON.stringify(spec)).toBe(false);
        }

        const wrongUsage = await plan(bundleOf([defaults(attestation)]));
        expect(wrongUsage.applicable).toBe(false);
        expect(wrongUsage.issues).toContainEqual(
            expect.objectContaining({
                code: "KEY_CHAIN_USAGE_MISMATCH",
                path: "/spec/access",
            }),
        );
    });

    test("accepts only an access token key chain as accessToken default and token.signingKeyId", async () => {
        const accepted = await plan(
            bundleOf([{ kind: "KeyChainDefaults", spec: { accessToken } }]),
        );
        expect(accepted.issues).toEqual([]);

        const wrongDefault = await plan(
            bundleOf([
                { kind: "KeyChainDefaults", spec: { accessToken: access } },
            ]),
        );
        expect(wrongDefault.issues).toContainEqual(
            expect.objectContaining({
                code: "KEY_CHAIN_USAGE_MISMATCH",
                path: "/spec/accessToken",
            }),
        );

        const issuance = (signingKeyId: string) =>
            bundleOf([
                {
                    kind: "IssuanceConfig",
                    spec: {
                        authorizationServers: [
                            {
                                type: "built-in",
                                id: "issuer-built-in",
                                token: { signingKeyId },
                            },
                        ],
                    },
                },
            ]);
        const wrongToken = await plan(issuance(attestation));
        expect(wrongToken.applicable).toBe(false);
        expect(wrongToken.issues).toContainEqual(
            expect.objectContaining({
                code: "KEY_CHAIN_USAGE_MISMATCH",
                path: "/spec/authorizationServers/0/token/signingKeyId",
                resource: { kind: "IssuanceConfig", id: "issuance" },
            }),
        );
        expect(
            (await plan(issuance(accessToken))).issues.filter(
                (issue) => issue.code === "KEY_CHAIN_USAGE_MISMATCH",
            ),
        ).toEqual([]);
    });

    test("sets the default from key-chain-defaults.json and removes it with an empty one", async () => {
        await importBundle(bundleOf([defaults(access)]));
        expect(await storedDefault()).toBe(access);

        // A tenant document leaves the default alone.
        await importBundle(
            bundleOf([{ kind: "Tenant", spec: { name: tenant } }]),
        );
        expect(await storedDefault()).toBe(access);

        await importBundle(bundleOf([defaults()]));
        expect(await storedDefault()).toBeUndefined();

        // Without entries, an empty document is the stored state.
        const empty = await plan(bundleOf([defaults()]));
        expect(
            empty.items.find((item) => item.kind === "KeyChainDefaults")
                ?.action,
        ).toBe("unchanged");
    });

    test("exports the default in the bundle and imports it again", async () => {
        await importBundle(bundleOf([defaults(access)]));

        const exported = await api()
            .get("/config-bundles/export")
            .set("Authorization", auth)
            .expect(200);
        const bundle: ConfigBundle = exported.body;
        expect(bundle.manifest.resources).toContainEqual(
            expect.objectContaining({
                kind: "KeyChainDefaults",
                id: "defaults",
            }),
        );
        expect(bundle.documents).toContainEqual(
            expect.objectContaining({
                $schema: schemaUrl("KeyChainDefaults"),
                spec: { access },
            }),
        );

        const roundTrip = await plan(bundle);
        expect(
            roundTrip.items.find((item) => item.kind === "KeyChainDefaults")
                ?.action,
        ).toBe("unchanged");
    });

    test("refuses API changes while the key chain defaults are file-managed, not while only info.json is", async () => {
        await importBundle(
            bundleOf([
                { kind: "Tenant", spec: { name: tenant } },
                defaults(access),
            ]),
        );
        await api()
            .put("/key-chain/access/default")
            .set("Authorization", auth)
            .send({ defaultAccessKeyChainId: null })
            .expect(409);

        await api()
            .post("/config-bundles/resources/KeyChainDefaults/defaults/detach")
            .set("Authorization", auth)
            .expect(201);
        await api()
            .put("/key-chain/access/default")
            .set("Authorization", auth)
            .send({ defaultAccessKeyChainId: null })
            .expect(200);
        const tenantOwnership = await api()
            .get("/config-bundles/resources/Tenant")
            .set("Authorization", auth)
            .expect(200);
        expect(tenantOwnership.body).toEqual([
            expect.objectContaining({ ownership: "file-managed" }),
        ]);
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
                    id: SINGLETONS[kind]?.id ?? spec.id,
                    $schema: documents[index].$schema,
                    path: SINGLETONS[kind]?.path ?? `${kind}/${spec.id}.json`,
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
                    kind: "KeyChainDefaults",
                    spec: { access: attestationKeyChain.id },
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
                kind: "KeyChainDefaults",
                spec: { access: accessKeyChain.id },
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

        // The stored defaults still name the key chain the bundle leaves out.
        const blocked = await plan(
            bundleOf([
                { kind: "KeyChain", spec: attestationKeyChain },
                {
                    kind: "KeyChainDefaults",
                    spec: { access: accessKeyChain.id },
                },
            ]),
            "replace",
        );
        expect(blocked.applicable).toBe(false);
        expect(keyChainItem(blocked)).toMatchObject({ action: "blocked" });
        expect(keyChainItem(blocked)?.issues).toContainEqual(
            expect.objectContaining({
                code: "KEY_CHAIN_IN_USE",
                message: expect.stringContaining(
                    "the tenant's key chain defaults",
                ),
            }),
        );

        // The same import without key-chain-defaults.json deletes the
        // defaults first.
        const dropped = await plan(
            bundleOf([{ kind: "KeyChain", spec: attestationKeyChain }]),
            "replace",
        );
        expect(dropped.applicable, JSON.stringify(dropped)).toBe(true);
        expect(keyChainItem(dropped)).toMatchObject({ action: "delete" });
        expect(dropped.items).toContainEqual(
            expect.objectContaining({
                kind: "KeyChainDefaults",
                action: "delete",
            }),
        );
        await api()
            .post(
                `/config-bundles/import?mode=replace&confirmReplace=true&planFingerprint=${dropped.planFingerprint}`,
            )
            .set("Authorization", auth)
            .send(bundleOf([{ kind: "KeyChain", spec: attestationKeyChain }]))
            .expect(201);

        const defaults = await api()
            .get("/key-chain/access/default")
            .set("Authorization", auth)
            .expect(200);
        expect(defaults.body).not.toHaveProperty("defaultAccessKeyChainId");
        const ownership = await api()
            .get("/config-bundles/resources/KeyChainDefaults")
            .set("Authorization", auth)
            .expect(200);
        expect(ownership.body).toEqual([]);
        await api()
            .get(`/key-chain/${accessKeyChain.id}`)
            .set("Authorization", auth)
            .expect(404);
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
