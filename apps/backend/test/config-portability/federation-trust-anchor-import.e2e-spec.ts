import "reflect-metadata";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schemaUrl } from "@eudiplo/config-format/config-format.js";
import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { Role } from "../../src/auth/roles/role.enum.js";
import { IssuanceConfig } from "../../src/issuer/configuration/issuance/entities/issuance-config.entity.js";
import { ConfigBundleApplyService } from "../../src/platform/config-portability/config-bundle-apply.service.js";
import { ConfigFolderBundleService } from "../../src/platform/config-portability/config-folder-bundle.service.js";
import type {
    ConfigBundle,
    ConfigImportPlan,
    ConfigResourceKind,
} from "../../src/platform/config-portability/config-resource.types.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { federationKey } from "../federation/federation-fixture.js";
import { clientToken, getTenantAdminToken } from "../utils.js";

const tenant = "federation-anchor-import";
const otherTenant = "federation-anchor-import-other";

/** A resource of a bundle with its serialized document. */
interface BundleEntry {
    kind: ConfigResourceKind;
    id: string;
    path: string;
    document: Record<string, any>;
}

/** A presentation config in which federation decides trust for `entityId`. */
function presentationSpec(id: string, entityId: string) {
    return {
        id,
        description: `Presentation config ${id}`,
        dcql_query: {
            credentials: [
                {
                    id: "pid",
                    format: "dc+sd-jwt",
                    meta: { vct_values: ["urn:eudi:pid:de:1"] },
                    claims: [{ path: ["given_name"] }],
                    trusted_authorities: [
                        { type: "openid_federation", values: [entityId] },
                    ],
                },
            ],
        },
    };
}

function entryOf(
    kind: ConfigResourceKind,
    id: string,
    path: string,
    spec: object,
): BundleEntry {
    return {
        kind,
        id,
        path,
        document: {
            $schema: schemaUrl(kind),
            metadata: { generation: 1 },
            spec,
        },
    };
}

function bundleOf(entries: BundleEntry[]): ConfigBundle {
    return {
        manifest: {
            format: "eudiplo.config-bundle",
            formatVersion: 2,
            sourceVersion: "federation-anchor-import",
            exportedAt: new Date(0).toISOString(),
            tenant,
            resources: entries.map(({ kind, id, path, document }) => ({
                kind,
                id,
                $schema: document.$schema,
                path,
                sha256: createHash("sha256")
                    .update(JSON.stringify(document))
                    .digest("hex"),
                ownership: "unmanaged",
                generation: document.metadata?.generation ?? 1,
            })),
            assets: [],
            requirements: [],
            warnings: [],
        },
        documents: entries.map((entry) => entry.document),
        assets: [],
    } as ConfigBundle;
}

describe("configuration imports and federation trust anchors", () => {
    let app: INestApplication<App>;
    let auth: string;
    let otherAuth: string;
    let jwks: { keys: object[] };

    const anchorSpec = (id: string, entityId: string) => ({
        id,
        entityId,
        jwks,
    });
    const anchorEntry = (id: string, entityId: string) =>
        entryOf(
            "FederationTrustAnchor",
            id,
            `federation-trust-anchors/${id}.json`,
            anchorSpec(id, entityId),
        );
    const presentationEntry = (id: string, entityId: string) =>
        entryOf(
            "PresentationConfig",
            id,
            `presentation/${id}.json`,
            presentationSpec(id, entityId),
        );

    const api = (token = auth) => ({
        get: (path: string) =>
            request(app.getHttpServer()).get(path).set("Authorization", token),
        post: (path: string, body: object) =>
            request(app.getHttpServer())
                .post(path)
                .set("Authorization", token)
                .send(body),
        patch: (path: string, body: object) =>
            request(app.getHttpServer())
                .patch(path)
                .set("Authorization", token)
                .send(body),
        delete: (path: string) =>
            request(app.getHttpServer())
                .delete(path)
                .set("Authorization", token),
    });

    async function plan(
        bundle: ConfigBundle,
        mode: "create" | "upsert" | "replace",
    ): Promise<ConfigImportPlan> {
        return (await api().post(`/config-bundles/plan?mode=${mode}`, bundle))
            .body;
    }

    function importBundle(
        bundle: ConfigBundle,
        mode: "create" | "upsert" | "replace",
        planFingerprint: string,
    ) {
        return api().post(
            `/config-bundles/import?mode=${mode}&confirmReplace=true&planFingerprint=${planFingerprint}`,
            bundle,
        );
    }

    async function anchorIds(token = auth): Promise<string[]> {
        const response = await api(token)
            .get("/federation-trust-anchor")
            .expect(200);
        return response.body.map((anchor: { id: string }) => anchor.id);
    }

    beforeAll(async () => {
        const moduleFixture = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(createAppValidationPipe());
        await app.init();

        const config = app.get(ConfigService);
        const token = (id: string) =>
            getTenantAdminToken(
                app,
                config.getOrThrow<string>("AUTH_CLIENT_ID"),
                config.getOrThrow<string>("AUTH_CLIENT_SECRET"),
                id,
                [Role.Issuances, Role.Presentations],
            );
        auth = `Bearer ${await token(tenant)}`;
        otherAuth = `Bearer ${await token(otherTenant)}`;
        jwks = { keys: [(await federationKey("ta-1")).jwk] };
    });

    afterAll(async () => {
        await app?.close();
    });

    test("applies a bundle with a trust anchor and a presentation config naming it in one go", async () => {
        const bundle = bundleOf([
            presentationEntry("bundled", "https://bundled.example.org"),
            anchorEntry("bundled-ta", "https://bundled.example.org"),
        ]);

        const result = await plan(bundle, "upsert");

        expect(result.applicable, JSON.stringify(result.issues)).toBe(true);
        await importBundle(bundle, "upsert", result.planFingerprint!).expect(
            201,
        );
        expect(await anchorIds()).toContain("bundled-ta");
        await api().get("/verifier/config/bundled").expect(200);
    });

    test("blocks a bundle whose configurations name an unregistered trust anchor", async () => {
        const bundle = bundleOf([
            presentationEntry("unpinned", "https://unpinned.example.org"),
            entryOf("IssuanceConfig", "issuance", "issuance/issuance.json", {
                authorizationServers: [
                    { id: "issuer-built-in", type: "built-in" },
                ],
                display: [],
                federation: {
                    trustAnchors: [
                        {
                            entityId: "https://unpinned-issuance.example.org",
                            entityConfigurationUri:
                                "https://unpinned-issuance.example.org/.well-known/openid-federation",
                        },
                    ],
                },
            }),
            // Another bundle anchor does not register these entity IDs.
            anchorEntry("unrelated-ta", "https://unrelated.example.org"),
        ]);

        const result = await plan(bundle, "upsert");

        expect(result.applicable).toBe(false);
        expect(
            result.items.find(
                (item) =>
                    item.kind === "PresentationConfig" &&
                    item.id === "unpinned",
            ),
        ).toMatchObject({
            action: "blocked",
            issues: [
                expect.objectContaining({
                    severity: "error",
                    code: "MISSING_RESOURCE_REFERENCE",
                    path: "/spec/dcql_query/credentials",
                    message: expect.stringContaining(
                        "'https://unpinned.example.org'",
                    ),
                }),
            ],
        });
        expect(
            result.items.find((item) => item.kind === "IssuanceConfig"),
        ).toMatchObject({
            action: "blocked",
            issues: [
                expect.objectContaining({
                    code: "MISSING_RESOURCE_REFERENCE",
                    path: "/spec/federation/trustAnchors",
                }),
            ],
        });
        const applied = await importBundle(
            bundle,
            "upsert",
            result.planFingerprint!,
        ).expect(400);
        expect(applied.body.code).toBe("CONFIG_APPLY_BLOCKED");
        expect(await anchorIds()).not.toContain("unrelated-ta");
    });

    test("does not count a trust anchor of a query with an etsi_tl entry", async () => {
        const spec = presentationSpec(
            "with-trust-list",
            "https://not-needed.example.org",
        );
        spec.dcql_query.credentials[0].trusted_authorities.push({
            type: "etsi_tl",
            values: [{ trustListId: "some-list" } as never],
        });
        const result = await plan(
            bundleOf([
                entryOf(
                    "PresentationConfig",
                    "with-trust-list",
                    "presentation/with-trust-list.json",
                    spec,
                ),
            ]),
            "upsert",
        );

        expect(
            result.issues.filter((issue) =>
                issue.message.includes("not-needed.example.org"),
            ),
        ).toEqual([]);
    });

    test("imports trust anchors from federation-trust-anchors/ of a config folder", async () => {
        const folder = mkdtempSync(join(tmpdir(), "federation-anchor-folder-"));
        mkdirSync(join(folder, "federation-trust-anchors"), {
            recursive: true,
        });
        mkdirSync(join(folder, "presentation"), { recursive: true });
        writeFileSync(
            join(folder, "federation-trust-anchors", "folder-ta.json"),
            JSON.stringify(
                anchorSpec("folder-ta", "https://folder.example.org"),
            ),
        );
        writeFileSync(
            join(folder, "presentation", "from-folder.json"),
            JSON.stringify(
                presentationSpec("from-folder", "https://folder.example.org"),
            ),
        );
        try {
            const bundle = app
                .get(ConfigFolderBundleService)
                .buildBundle(tenant, folder);
            expect(
                bundle.manifest.resources.map(({ kind, id }) => ({ kind, id })),
            ).toEqual(
                expect.arrayContaining([
                    { kind: "FederationTrustAnchor", id: "folder-ta" },
                    { kind: "PresentationConfig", id: "from-folder" },
                ]),
            );

            await app
                .get(ConfigBundleApplyService)
                .apply(tenant, bundle, "upsert", `folder:${folder}`);

            await api()
                .get("/federation-trust-anchor/folder-ta")
                .expect(200)
                .expect((res) =>
                    expect(res.body).toMatchObject({
                        entityId: "https://folder.example.org",
                        jwks,
                    }),
                );
            await api().get("/verifier/config/from-folder").expect(200);
        } finally {
            rmSync(folder, { recursive: true, force: true });
        }
    });

    describe("trust anchors that configurations name", () => {
        /** Of the bundle-managed anchor. */
        const entityId = "https://in-use.example.org";
        /** Of the anchor registered through the API. */
        const apiEntityId = "https://api-in-use.example.org";
        const issuanceConfig = (entityIds: string[]) => ({
            authorizationServers: [{ id: "issuer-built-in", type: "built-in" }],
            display: [],
            federation: {
                trustAnchors: entityIds.map((id) => ({
                    entityId: id,
                    entityConfigurationUri: `${id}/.well-known/openid-federation`,
                })),
            },
        });

        beforeAll(async () => {
            // The bundle source takes over the anchor and a configuration.
            const takeOver = bundleOf([
                anchorEntry("in-use-ta", entityId),
                anchorEntry("spare-ta", "https://spare.example.org"),
                presentationEntry("managed", entityId),
            ]);
            const takeOverPlan = await plan(takeOver, "upsert");
            expect(takeOverPlan.applicable, JSON.stringify(takeOverPlan)).toBe(
                true,
            );
            await importBundle(
                takeOver,
                "upsert",
                takeOverPlan.planFingerprint!,
            ).expect(201);
            // An anchor and configurations outside the bundle.
            await api()
                .post(
                    "/federation-trust-anchor",
                    anchorSpec("api-ta", apiEntityId),
                )
                .expect(201);
            for (const [id, named] of [
                ["stored", entityId],
                ["api-stored", apiEntityId],
                ["api-stored-2", apiEntityId],
            ]) {
                await api()
                    .post("/verifier/config", presentationSpec(id, named))
                    .expect(201);
            }
            await api()
                .post("/issuer/config", issuanceConfig([entityId, apiEntityId]))
                .expect(201);
        });

        test("refuses to delete the anchor or change its entity ID", async () => {
            const deleted = await api()
                .delete("/federation-trust-anchor/api-ta")
                .expect(409);
            expect(deleted.body).toMatchObject({
                code: "FEDERATION_TRUST_ANCHOR_IN_USE",
                message: `Federation trust anchor "api-ta" (${apiEntityId}) is still named by 2 presentation configs ("api-stored" and "api-stored-2") and the issuance configuration (federation.trustAnchors). Remove these references before deleting it.`,
            });
            expect(deleted.body.references).toHaveLength(3);
            expect(deleted.body.references).toEqual(
                expect.arrayContaining([
                    {
                        kind: "PresentationConfig",
                        id: "api-stored",
                        description: "Presentation config api-stored",
                    },
                    { kind: "IssuanceConfig" },
                ]),
            );

            const changed = await api()
                .patch("/federation-trust-anchor/api-ta", {
                    entityId: "https://moved.example.org",
                })
                .expect(409);
            expect(changed.body.code).toBe("FEDERATION_TRUST_ANCHOR_IN_USE");
            expect(changed.body.message).toContain(
                "before changing its entity ID",
            );
            // Other fields stay editable.
            await api()
                .patch("/federation-trust-anchor/api-ta", {
                    description: "Still in use",
                })
                .expect(200);
            expect(await anchorIds()).toContain("api-ta");
        });

        test("hides configurations the caller may not read", async () => {
            const issuanceOnly = `Bearer ${await clientToken(
                app,
                auth.slice("Bearer ".length),
                "federation-anchor-issuance-only",
                [Role.Issuances],
            )}`;
            const response = await api(issuanceOnly)
                .delete("/federation-trust-anchor/api-ta")
                .expect(409);
            expect(response.body.references).toHaveLength(3);
            expect(response.body.references).toEqual(
                expect.arrayContaining([
                    { kind: "IssuanceConfig" },
                    { kind: "PresentationConfig" },
                ]),
            );
            expect(response.body.message).toContain(
                "2 presentation configs (presentation:read shows which)",
            );
        });

        test("blocks a replace plan that deletes the anchor", async () => {
            const bundle = bundleOf([
                anchorEntry("spare-ta", "https://spare.example.org"),
            ]);

            const result = await plan(bundle, "replace");

            expect(result.applicable).toBe(false);
            // "managed" is deleted by the same plan, so it does not count.
            expect(
                result.items.find(
                    (item) =>
                        item.kind === "PresentationConfig" &&
                        item.id === "managed",
                )?.action,
            ).toBe("delete");
            const item = result.items.find(
                (candidate) =>
                    candidate.kind === "FederationTrustAnchor" &&
                    candidate.id === "in-use-ta",
            );
            expect(item).toMatchObject({
                action: "blocked",
                issues: [
                    {
                        severity: "error",
                        code: "FEDERATION_TRUST_ANCHOR_IN_USE",
                        path: "/metadata/id",
                        message: `Federation trust anchor "in-use-ta" is left out of this import, so replace mode deletes it, but ${entityId} is still named by 1 presentation config ("stored") and the issuance configuration (federation.trustAnchors). Keep the trust anchor in the bundle or folder, or remove these references.`,
                        resource: {
                            kind: "FederationTrustAnchor",
                            id: "in-use-ta",
                        },
                    },
                ],
            });
            const applied = await importBundle(
                bundle,
                "replace",
                result.planFingerprint!,
            ).expect(400);
            expect(applied.body.code).toBe("CONFIG_APPLY_BLOCKED");
            expect(await anchorIds()).toContain("in-use-ta");
        });

        test("blocks an import that changes the entity ID of the anchor", async () => {
            const result = await plan(
                bundleOf([
                    anchorEntry("in-use-ta", "https://moved.example.org"),
                    presentationEntry("managed", "https://moved.example.org"),
                ]),
                "upsert",
            );

            expect(result.applicable).toBe(false);
            expect(
                result.items.find(
                    (item) =>
                        item.kind === "FederationTrustAnchor" &&
                        item.id === "in-use-ta",
                )?.issues,
            ).toEqual([
                expect.objectContaining({
                    code: "FEDERATION_TRUST_ANCHOR_IN_USE",
                    path: "/spec/entityId",
                    message: expect.stringContaining(
                        `This import changes the entity ID of federation trust anchor "in-use-ta", but ${entityId} is still named by`,
                    ),
                }),
            ]);
        });

        test("keeps the stored entity ID of an anchor that create mode skips", async () => {
            const result = await plan(
                bundleOf([
                    anchorEntry("in-use-ta", "https://moved.example.org"),
                ]),
                "create",
            );

            expect(result.applicable, JSON.stringify(result.issues)).toBe(true);
            expect(
                result.items.find(
                    (item) =>
                        item.kind === "FederationTrustAnchor" &&
                        item.id === "in-use-ta",
                )?.action,
            ).toBe("skip");
        });

        test("deletes the anchor once no surviving configuration names it", async () => {
            await api().delete("/verifier/config/stored").expect(204);
            await api()
                .post("/issuer/config", issuanceConfig([apiEntityId]))
                .expect(201);
            const bundle = bundleOf([
                anchorEntry("spare-ta", "https://spare.example.org"),
            ]);

            const result = await plan(bundle, "replace");

            expect(result.applicable, JSON.stringify(result.issues)).toBe(true);
            await importBundle(
                bundle,
                "replace",
                result.planFingerprint!,
            ).expect(201);
            expect(await anchorIds()).not.toContain("in-use-ta");

            for (const id of ["api-stored", "api-stored-2"]) {
                await api().delete(`/verifier/config/${id}`).expect(204);
            }
            await api().post("/issuer/config", issuanceConfig([])).expect(201);
            await api().delete("/federation-trust-anchor/api-ta").expect(204);
        });
    });

    test("applies an import that moves an anchor to another entity ID with every configuration naming it", async () => {
        const before = bundleOf([
            anchorEntry("move-ta", "https://move-from.example.org"),
            presentationEntry("moving", "https://move-from.example.org"),
        ]);
        const beforePlan = await plan(before, "upsert");
        await importBundle(
            before,
            "upsert",
            beforePlan.planFingerprint!,
        ).expect(201);

        // The anchor is written before the configurations (lower import
        // phase), so apply must not check the old entity ID's references.
        const moved = bundleOf([
            anchorEntry("move-ta", "https://move-to.example.org"),
            presentationEntry("moving", "https://move-to.example.org"),
        ]);
        const result = await plan(moved, "upsert");

        expect(result.applicable, JSON.stringify(result.issues)).toBe(true);
        await importBundle(moved, "upsert", result.planFingerprint!).expect(
            201,
        );
        await api()
            .get("/federation-trust-anchor/move-ta")
            .expect(200)
            .expect((res) =>
                expect(res.body.entityId).toBe("https://move-to.example.org"),
            );
    });

    test("does not block an issuance configuration for an unregistered entity ID it already names", async () => {
        const legacy = "https://legacy.example.org";
        // As stored before trust anchors had to be registered.
        await app
            .get(DataSource)
            .getRepository(IssuanceConfig)
            .update(
                { tenantId: tenant },
                {
                    federation: {
                        trustAnchors: [
                            {
                                entityId: legacy,
                                entityConfigurationUri: `${legacy}/.well-known/openid-federation`,
                            },
                        ],
                    },
                },
            );
        const issuance = (entityIds: string[]) => {
            const entry = entryOf(
                "IssuanceConfig",
                "issuance",
                "issuance/issuance.json",
                {
                    authorizationServers: [
                        { id: "issuer-built-in", type: "built-in" },
                    ],
                    display: [],
                    federation: {
                        cacheTtlSeconds: 60,
                        trustAnchors: entityIds.map((id) => ({
                            entityId: id,
                            entityConfigurationUri: `${id}/.well-known/openid-federation`,
                        })),
                    },
                },
            );
            // Newer than the generations earlier imports stored.
            entry.document.metadata.generation = 10;
            return entry;
        };
        try {
            const kept = await plan(bundleOf([issuance([legacy])]), "upsert");
            const item = kept.items.find(
                (candidate) => candidate.kind === "IssuanceConfig",
            );
            expect(item?.action, JSON.stringify(item?.issues)).toBe("update");

            const added = await plan(
                bundleOf([issuance([legacy, "https://added.example.org"])]),
                "upsert",
            );
            expect(
                added.items.find(
                    (candidate) => candidate.kind === "IssuanceConfig",
                )?.issues,
            ).toEqual([
                expect.objectContaining({
                    code: "MISSING_RESOURCE_REFERENCE",
                    message: expect.stringContaining(
                        "'https://added.example.org'",
                    ),
                }),
            ]);
        } finally {
            await app
                .get(DataSource)
                .getRepository(IssuanceConfig)
                .update({ tenantId: tenant }, { federation: null });
        }
    });

    test("keeps trust anchors apart between tenants", async () => {
        await api()
            .post(
                "/federation-trust-anchor",
                anchorSpec("isolated-ta", "https://isolated.example.org"),
            )
            .expect(201);

        const other = api(otherAuth);
        await other.get("/federation-trust-anchor/isolated-ta").expect(404);
        await other
            .patch("/federation-trust-anchor/isolated-ta", {
                description: "Taken over",
            })
            .expect(404);
        await other.delete("/federation-trust-anchor/isolated-ta").expect(404);
        expect(await anchorIds(otherAuth)).not.toContain("isolated-ta");

        // The same ID and entity ID are free in the other tenant.
        await other
            .post(
                "/federation-trust-anchor",
                anchorSpec("isolated-ta", "https://isolated.example.org"),
            )
            .expect(201);
        // A configuration of the other tenant does not hold this tenant's anchor.
        await other
            .post(
                "/verifier/config",
                presentationSpec(
                    "other-tenant",
                    "https://isolated.example.org",
                ),
            )
            .expect(201);
        await api().delete("/federation-trust-anchor/isolated-ta").expect(204);
        await other.get("/federation-trust-anchor/isolated-ta").expect(200);
    });
});
