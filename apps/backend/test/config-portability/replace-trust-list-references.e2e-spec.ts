import "reflect-metadata";
import { createHash } from "node:crypto";
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
import type { KeyChainImportDto } from "../../src/crypto/key/dto/key-chain-import.dto.js";
import type {
    ConfigBundle,
    ConfigImportPlan,
    ConfigResourceKind,
} from "../../src/platform/config-portability/config-resource.types.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { getTenantAdminToken, readConfig } from "../utils.js";

const tenant = "replace-trust-list-references";
const keptList = "kept-list";
const droppedList = "dropped-list";
/** Deleted by the replace imports and referenced by no configuration. */
const spareList = "spare-list";
const trustListKeyChain = "570852d7-7e7f-40af-a0e3-a6ebffd75ed0";
const attestationKeyChain = "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad";
const statusListKeyChain = "1f8c6b29-a4d3-4e7f-b2a0-9c5d13e8f746";

/** A resource of a bundle with its serialized document. */
interface BundleEntry {
    kind: ConfigResourceKind;
    id: string;
    path: string;
    document: Record<string, any>;
}

/** A presentation config whose DCQL query accepts issuers from `ref`. */
function presentationSpec(id: string, ref: object) {
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
                    trusted_authorities: [{ type: "etsi_tl", values: [ref] }],
                },
            ],
        },
    };
}

function presentationEntry(id: string, ref: object): BundleEntry {
    return {
        kind: "PresentationConfig",
        id,
        path: `presentation/${id}.json`,
        document: {
            $schema: schemaUrl("PresentationConfig"),
            metadata: { generation: 1 },
            spec: presentationSpec(id, ref),
        },
    };
}

function bundleOf(entries: BundleEntry[]): ConfigBundle {
    return {
        manifest: {
            format: "eudiplo.config-bundle",
            formatVersion: 2,
            sourceVersion: "replace-trust-list-references",
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

describe("replace imports and trust lists that configurations reference", () => {
    let app: INestApplication<App>;
    let auth: string;
    /** Exported documents by `<kind>/<id>`. */
    const exported = new Map<string, BundleEntry>();

    function entry(kind: ConfigResourceKind, id: string): BundleEntry {
        const found = exported.get(`${kind}/${id}`);
        if (!found) throw new Error(`${kind}/${id} was not exported`);
        return found;
    }

    /** The exported document with `spec` changed by `change`. */
    function rewritten(
        kind: ConfigResourceKind,
        id: string,
        change: (spec: Record<string, any>) => Record<string, any>,
    ): BundleEntry {
        const original = entry(kind, id);
        return {
            ...original,
            document: {
                ...original.document,
                spec: change(structuredClone(original.document.spec)),
            },
        };
    }

    async function plan(
        bundle: ConfigBundle,
        mode: "upsert" | "replace",
    ): Promise<ConfigImportPlan> {
        const response = await request(app.getHttpServer())
            .post(`/config-bundles/plan?mode=${mode}`)
            .set("Authorization", auth)
            .send(bundle)
            .expect(201);
        return response.body;
    }

    function importBundle(
        bundle: ConfigBundle,
        mode: "upsert" | "replace",
        planFingerprint: string,
    ) {
        return request(app.getHttpServer())
            .post(
                `/config-bundles/import?mode=${mode}&confirmReplace=true&planFingerprint=${planFingerprint}`,
            )
            .set("Authorization", auth)
            .send(bundle);
    }

    async function trustListIds(): Promise<string[]> {
        const response = await request(app.getHttpServer())
            .get("/trust-list")
            .set("Authorization", auth)
            .expect(200);
        return response.body.map((list: { id: string }) => list.id);
    }

    function droppedListItem(result: ConfigImportPlan) {
        return result.items.find(
            (item) => item.kind === "TrustList" && item.id === droppedList,
        );
    }

    beforeAll(async () => {
        const moduleFixture = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(createAppValidationPipe());
        await app.init();

        const config = app.get(ConfigService);
        auth = `Bearer ${await getTenantAdminToken(
            app,
            config.getOrThrow<string>("AUTH_CLIENT_ID"),
            config.getOrThrow<string>("AUTH_CLIENT_SECRET"),
            tenant,
            [Role.Issuances, Role.Presentations, Role.Keys],
        )}`;
        const server = app.getHttpServer();
        const fixtures = resolve(__dirname, "../fixtures/haip");
        for (const file of ["trust-list", "attestation", "status-list"]) {
            await request(server)
                .post("/key-chain/import")
                .set("Authorization", auth)
                .send(
                    readConfig<KeyChainImportDto>(
                        join(fixtures, `key-chains/${file}.json`),
                    ),
                )
                .expect(201);
        }
        for (const id of [keptList, droppedList, spareList]) {
            await request(server)
                .post("/trust-list")
                .set("Authorization", auth)
                .send({
                    id,
                    keyChainId: trustListKeyChain,
                    entities: [
                        {
                            type: "internal",
                            issuerKeyChainId: attestationKeyChain,
                            revocationKeyChainId: statusListKeyChain,
                            info: {
                                name: `Provider of ${id}`,
                                contactUri: "info@example.com",
                                website: "https://example.com/",
                            },
                        },
                    ],
                })
                .expect(201);
        }

        // Configurations created through the API, outside any bundle.
        await request(server)
            .post("/verifier/config")
            .set("Authorization", auth)
            .send(
                presentationSpec("stored-by-url", {
                    url: `<TENANT_URL>/trust-list/${droppedList}`,
                }),
            )
            .expect(201);
        await request(server)
            .post("/issuer/credentials")
            .set("Authorization", auth)
            .send({
                ...readConfig<Record<string, unknown>>(
                    join(fixtures, "issuance/credentials/pid-no-key.json"),
                ),
                id: "stored-credential",
                schemaMeta: {
                    version: "1.0.0",
                    attestationLoS: "iso_18045_high",
                    bindingType: "key",
                    trustedAuthorities: [
                        {
                            frameworkType: "etsi_tl",
                            value: `http://localhost:3000/issuers/${tenant}/trust-list/${droppedList}`,
                        },
                    ],
                },
            })
            .expect(201);
        await request(server)
            .post("/issuer/config")
            .set("Authorization", auth)
            .send({
                authorizationServers: [
                    { id: "issuer-built-in", type: "built-in" },
                ],
                walletProviderTrustLists: [{ trustListId: droppedList }],
                // Without it, the export writes display: null, which its own
                // schema rejects.
                display: [],
            })
            .expect(201);

        const bundle: ConfigBundle = (
            await request(server)
                .get("/config-bundles/export")
                .set("Authorization", auth)
                .expect(200)
        ).body;
        bundle.manifest.resources.forEach((resource, index) => {
            exported.set(`${resource.kind}/${resource.id}`, {
                kind: resource.kind,
                id: resource.id,
                path: resource.path,
                document: bundle.documents[index] as Record<string, any>,
            });
        });

        // The bundle source takes over both lists and creates "managed",
        // which references the dropped list as well.
        const takeOver = bundleOf([
            entry("TrustList", keptList),
            entry("TrustList", droppedList),
            entry("TrustList", spareList),
            presentationEntry("managed", { trustListId: droppedList }),
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
    });

    afterAll(async () => {
        await app?.close();
    });

    test("blocks deleting a list that stored configurations outside the bundle reference", async () => {
        const bundle = bundleOf([entry("TrustList", keptList)]);

        const result = await plan(bundle, "replace");

        expect(result.applicable).toBe(false);
        // "managed" is deleted by the same plan, so it does not count.
        expect(
            result.items.find(
                (item) =>
                    item.kind === "PresentationConfig" && item.id === "managed",
            )?.action,
        ).toBe("delete");
        const item = droppedListItem(result);
        expect(item?.action).toBe("blocked");
        expect(item?.issues).toEqual([
            {
                severity: "error",
                code: "TRUST_LIST_IN_USE",
                path: "/metadata/id",
                message: `Trust list "${droppedList}" is left out of this import, so replace mode deletes it, but it is still referenced by 1 presentation config ("stored-by-url"), 1 credential config ("stored-credential") and the issuance configuration (wallet provider trust lists). Keep the trust list in the bundle or folder, or remove these references.`,
                resource: { kind: "TrustList", id: droppedList },
            },
        ]);
        expect(result.issues).toContainEqual(item?.issues[0]);
        // Each deleted list gets its own verdict.
        expect(
            result.items.find(
                (candidate) =>
                    candidate.kind === "TrustList" &&
                    candidate.id === spareList,
            ),
        ).toMatchObject({ action: "delete", issues: [] });

        const applied = await importBundle(
            bundle,
            "replace",
            result.planFingerprint!,
        ).expect(400);
        expect(applied.body.code).toBe("CONFIG_APPLY_BLOCKED");
        expect(await trustListIds()).toContain(droppedList);
    });

    test("checks bundle documents with their new content, including references by URL", async () => {
        const bundle = bundleOf([
            entry("TrustList", keptList),
            // The rewritten configurations no longer reference the list.
            presentationEntry("stored-by-url", { trustListId: keptList }),
            rewritten("CredentialConfig", "stored-credential", (spec) => ({
                ...spec,
                schemaMeta: {
                    ...spec.schemaMeta,
                    trustedAuthorities: [{ trustListId: keptList }],
                },
            })),
            rewritten("IssuanceConfig", "issuance", (spec) => ({
                ...spec,
                walletProviderTrustLists: [{ trustListId: keptList }],
            })),
            // A new configuration names the list only by URL.
            presentationEntry("bundle-by-url", {
                url: `https://issuer.example/issuers/${tenant}/trust-list/${droppedList}`,
            }),
        ]);

        const result = await plan(bundle, "replace");

        expect(result.applicable).toBe(false);
        expect(droppedListItem(result)?.issues).toEqual([
            expect.objectContaining({
                code: "TRUST_LIST_IN_USE",
                message: expect.stringContaining(
                    'still referenced by 1 presentation config ("bundle-by-url").',
                ),
            }),
        ]);
        // Before this check, only references by trustListId were blocked.
        expect(
            result.issues.filter(
                (issue) => issue.code === "MISSING_RESOURCE_REFERENCE",
            ),
        ).toEqual([]);
    });

    test("keeps the stored content of a document the plan skips", async () => {
        await request(app.getHttpServer())
            .post("/config-bundles/resources/PresentationConfig/managed/detach")
            .set("Authorization", auth)
            .expect(201);
        const bundle = bundleOf([
            entry("TrustList", keptList),
            presentationEntry("stored-by-url", { trustListId: keptList }),
            rewritten("CredentialConfig", "stored-credential", (spec) => ({
                ...spec,
                schemaMeta: {
                    ...spec.schemaMeta,
                    trustedAuthorities: [{ trustListId: keptList }],
                },
            })),
            rewritten("IssuanceConfig", "issuance", (spec) => ({
                ...spec,
                walletProviderTrustLists: [{ trustListId: keptList }],
            })),
            // Detached, so skipped: the stored version still uses the list.
            presentationEntry("managed", { trustListId: keptList }),
        ]);

        const result = await plan(bundle, "replace");

        expect(
            result.items.find(
                (item) =>
                    item.kind === "PresentationConfig" && item.id === "managed",
            )?.action,
        ).toBe("skip");
        expect(droppedListItem(result)?.issues).toEqual([
            expect.objectContaining({
                code: "TRUST_LIST_IN_USE",
                message: expect.stringContaining(
                    'still referenced by 1 presentation config ("managed").',
                ),
            }),
        ]);
    });

    test("deletes the list once no surviving configuration references it", async () => {
        await request(app.getHttpServer())
            .delete("/verifier/config/managed")
            .set("Authorization", auth)
            .expect(204);
        const bundle = bundleOf([
            entry("TrustList", keptList),
            presentationEntry("stored-by-url", { trustListId: keptList }),
            rewritten("CredentialConfig", "stored-credential", (spec) => ({
                ...spec,
                schemaMeta: {
                    ...spec.schemaMeta,
                    trustedAuthorities: [{ trustListId: keptList }],
                },
            })),
            rewritten("IssuanceConfig", "issuance", (spec) => ({
                ...spec,
                walletProviderTrustLists: [{ trustListId: keptList }],
            })),
        ]);

        const result = await plan(bundle, "replace");

        expect(result.applicable, JSON.stringify(result.issues)).toBe(true);
        expect(droppedListItem(result)).toMatchObject({
            action: "delete",
            issues: [],
        });
        await importBundle(bundle, "replace", result.planFingerprint!).expect(
            201,
        );
        expect(await trustListIds()).toEqual([keptList]);
    });
});
