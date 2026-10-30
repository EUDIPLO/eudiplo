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
import type { KeyChainImportDto } from "../../src/crypto/key/dto/key-chain-import.dto.js";
import { KeyUsageType } from "../../src/crypto/key/types/key-usage-type.js";
import type {
    ConfigBundle,
    ConfigImportPlan,
    ConfigResourceKind,
} from "../../src/platform/config-portability/config-resource.types.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { getTenantAdminToken, readConfig } from "../utils.js";
import { createKeyChain } from "../utils-ec.js";

const fixtures = resolve(__dirname, "../fixtures/haip");
const trustListKeyChain = "570852d7-7e7f-40af-a0e3-a6ebffd75ed0";
const attestationKeyChain = "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad";
const statusListKeyChain = "1f8c6b29-a4d3-4e7f-b2a0-9c5d13e8f746";
const accessKeyChain = "2f71c235-87e2-43c9-b572-739a3164ce95";

function fixtureKeyChain(file: string): KeyChainImportDto {
    return readConfig<KeyChainImportDto>(
        join(fixtures, `key-chains/${file}.json`),
    );
}

/** A presentation config that accepts issuers of trust list `tl`. */
function presentationConfig(id: string, accessKeyChainId?: string) {
    return {
        id,
        description: `Presentation config ${id}`,
        ...(accessKeyChainId ? { accessKeyChainId } : {}),
        dcql_query: {
            credentials: [
                {
                    id: "pid",
                    format: "dc+sd-jwt",
                    meta: { vct_values: ["urn:eudi:pid:de:1"] },
                    claims: [{ path: ["given_name"] }],
                    trusted_authorities: [
                        { type: "etsi_tl", values: [{ trustListId: "tl" }] },
                    ],
                },
            ],
        },
    };
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

describe("DELETE /key-chain/{id} while configurations name the key chain", () => {
    let app: INestApplication<App>;
    let auth: string;
    /** Named by the issuance configuration and credential config "signed-pid". */
    let sharedKey: string;
    /** Named by an authorization server's token settings. */
    let tokenKey: string;
    /** Named by presentation config "pinned-access". */
    let accessKey: string;
    /** Named by a status list. */
    let statusKey: string;
    let statusListId: string;

    const api = () => request(app.getHttpServer());

    beforeAll(async () => {
        app = await createApp();
        auth = `Bearer ${await tenantToken(app, "key-chain-references", [
            Role.Issuances,
            Role.Presentations,
            Role.Keys,
            Role.Clients,
        ])}`;

        for (const file of [
            "trust-list",
            "attestation",
            "status-list",
            "access",
        ]) {
            await api()
                .post("/key-chain/import")
                .set("Authorization", auth)
                .send(fixtureKeyChain(file))
                .expect(201);
        }
        const token = auth.slice("Bearer ".length);
        sharedKey = await createKeyChain(app, token, {
            usageType: KeyUsageType.Attestation,
            description: "shared",
        });
        tokenKey = await createKeyChain(app, token, {
            usageType: KeyUsageType.AccessToken,
            description: "token",
        });
        accessKey = await createKeyChain(app, token, {
            usageType: KeyUsageType.Access,
            description: "access",
        });
        statusKey = await createKeyChain(app, token, {
            usageType: KeyUsageType.StatusList,
            description: "status",
        });

        await api()
            .post("/trust-list")
            .set("Authorization", auth)
            .send({
                id: "tl",
                description: "PID issuers",
                keyChainId: trustListKeyChain,
                entities: [
                    {
                        type: "internal",
                        issuerKeyChainId: attestationKeyChain,
                        revocationKeyChainId: statusListKeyChain,
                        info: { name: "Provider" },
                    },
                ],
            })
            .expect(201);
        await api()
            .post("/issuer/credentials")
            .set("Authorization", auth)
            .send({
                ...readConfig<Record<string, unknown>>(
                    join(fixtures, "issuance/credentials/pid-no-key.json"),
                ),
                id: "signed-pid",
                keyChainId: sharedKey,
            })
            .expect(201);
        await api()
            .post("/issuer/config")
            .set("Authorization", auth)
            .send({
                authorizationServers: [
                    {
                        id: "issuer-built-in",
                        type: "built-in",
                        token: { signingKeyId: tokenKey },
                    },
                ],
            })
            .expect(201);
        await api()
            .post("/verifier/config")
            .set("Authorization", auth)
            .send(presentationConfig("pinned-access", accessKey))
            .expect(201);
        // Uses the tenant's default access key chain; names none.
        await api()
            .post("/verifier/config")
            .set("Authorization", auth)
            .send(presentationConfig("default-access"))
            .expect(201);
        const statusList = await api()
            .post("/status-lists")
            .set("Authorization", auth)
            .send({ keyChainId: statusKey })
            .expect(201);
        statusListId = statusList.body.id;
    });

    afterAll(async () => {
        await app?.close();
    });

    test("refuses with 409 and names the configurations", async () => {
        const response = await api()
            .delete(`/key-chain/${sharedKey}`)
            .set("Authorization", auth)
            .expect(409);

        expect(response.body.code).toBe("KEY_CHAIN_IN_USE");
        expect(response.body.message).toBe(
            `Key chain "${sharedKey}" is still used by 1 credential config ("signed-pid"). Remove these references before deleting the key chain.`,
        );
        expect(response.body.references).toEqual(
            expect.arrayContaining([
                {
                    kind: "CredentialConfig",
                    id: "signed-pid",
                    description: "Personal ID",
                },
            ]),
        );

        await api()
            .get(`/key-chain/${sharedKey}`)
            .set("Authorization", auth)
            .expect(200);
    });

    test("counts an authorization server's token signing key", async () => {
        const response = await api()
            .delete(`/key-chain/${tokenKey}`)
            .set("Authorization", auth)
            .expect(409);

        expect(response.body.references).toEqual([{ kind: "IssuanceConfig" }]);
    });

    test("names presentation configs, status lists and trust lists", async () => {
        const references = async (id: string) =>
            (
                await api()
                    .delete(`/key-chain/${id}`)
                    .set("Authorization", auth)
                    .expect(409)
            ).body.references;

        expect(await references(accessKey)).toEqual([
            {
                kind: "PresentationConfig",
                id: "pinned-access",
                description: "Presentation config pinned-access",
            },
        ]);
        expect(await references(statusKey)).toEqual([
            { kind: "StatusList", id: statusListId },
        ]);
        // Signs the trust list.
        expect(await references(trustListKeyChain)).toEqual([
            { kind: "TrustList", id: "tl", description: "PID issuers" },
        ]);
        // Provides the certificate of an internal entity of the trust list.
        expect(await references(attestationKeyChain)).toEqual([
            { kind: "TrustList", id: "tl", description: "PID issuers" },
        ]);

        await api()
            .get("/trust-list/tl")
            .set("Authorization", auth)
            .expect(200);
    });

    test("counts configurations the caller's roles cannot read", async () => {
        const created = await api()
            .post("/client")
            .set("Authorization", auth)
            .send({ clientId: "key-custodian", roles: [Role.Keys] })
            .expect(201);
        const token = await api()
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: "key-custodian",
                client_secret: created.body.clientSecret,
            })
            .expect(201);

        const response = await api()
            .delete(`/key-chain/${sharedKey}`)
            .set("Authorization", `Bearer ${token.body.access_token}`)
            .expect(409);

        expect(response.body.message).toBe(
            `Key chain "${sharedKey}" is still used by 1 credential config (issuance:manage shows which). Remove these references before deleting the key chain.`,
        );
        expect(response.body.references).toEqual([
            { kind: "CredentialConfig" },
        ]);

        const access = await api()
            .delete(`/key-chain/${accessKey}`)
            .set("Authorization", `Bearer ${token.body.access_token}`)
            .expect(409);
        expect(access.body.references).toEqual([
            { kind: "PresentationConfig" },
        ]);
        expect(access.body.message).toContain(
            "1 presentation config (presentation:manage or presentation:request shows which)",
        );
        const lists = await api()
            .delete(`/key-chain/${statusKey}`)
            .set("Authorization", `Bearer ${token.body.access_token}`)
            .expect(409);
        expect(lists.body.message).toContain(
            "1 status list (issuance:manage shows which)",
        );
        const trustList = await api()
            .delete(`/key-chain/${trustListKeyChain}`)
            .set("Authorization", `Bearer ${token.body.access_token}`)
            .expect(409);
        expect(trustList.body.message).toContain(
            "1 trust list (issuance:manage or presentation:manage shows which)",
        );
    });

    test("names trust lists for presentation:manage", async () => {
        const created = await api()
            .post("/client")
            .set("Authorization", auth)
            .send({
                clientId: "verifier-key-custodian",
                roles: [Role.Keys, Role.Presentations],
            })
            .expect(201);
        const token = await api()
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: "verifier-key-custodian",
                client_secret: created.body.clientSecret,
            })
            .expect(201);

        const response = await api()
            .delete(`/key-chain/${trustListKeyChain}`)
            .set("Authorization", `Bearer ${token.body.access_token}`)
            .expect(409);

        expect(response.body.references).toEqual([
            { kind: "TrustList", id: "tl", description: "PID issuers" },
        ]);
    });

    test("deletes the default key chain that a configuration uses without naming it", async () => {
        await api()
            .delete(`/key-chain/${accessKeyChain}`)
            .set("Authorization", auth)
            .expect(204);
        await api()
            .get(`/key-chain/${accessKeyChain}`)
            .set("Authorization", auth)
            .expect(404);
    });

    test("deletes a key chain once its references are gone", async () => {
        await api()
            .delete(`/status-lists/${statusListId}`)
            .set("Authorization", auth)
            .expect(204);

        await api()
            .delete(`/key-chain/${statusKey}`)
            .set("Authorization", auth)
            .expect(204);
    });

    test("answers 404 for an unknown key chain", async () => {
        await api()
            .delete("/key-chain/does-not-exist")
            .set("Authorization", auth)
            .expect(404);
    });
});

describe("replace imports and key chains that configurations name", () => {
    const tenant = "replace-key-chain-references";
    let app: INestApplication<App>;
    let auth: string;
    let statusListId: string;

    const api = () => request(app.getHttpServer());

    /** A document of `kind` with `spec`, as a bundle carries it. */
    function document(kind: ConfigResourceKind, spec: Record<string, any>) {
        return { $schema: schemaUrl(kind), metadata: { generation: 1 }, spec };
    }

    /** A bundle of fixture key chain documents and `others`. */
    function bundleOf(
        files: string[],
        others: Array<{ kind: ConfigResourceKind; document: any }> = [],
    ): ConfigBundle {
        const entries = [
            ...files.map((file) => ({
                kind: "KeyChain" as ConfigResourceKind,
                document: JSON.parse(
                    readFileSync(
                        join(fixtures, `key-chains/${file}.json`),
                        "utf8",
                    ),
                ) as Record<string, any>,
            })),
            ...others,
        ];
        return {
            manifest: {
                format: "eudiplo.config-bundle",
                formatVersion: 2,
                sourceVersion: "replace-key-chain-references",
                exportedAt: new Date(0).toISOString(),
                tenant,
                resources: entries.map(({ kind, document }) => ({
                    kind,
                    id: document.spec.id,
                    $schema: document.$schema,
                    path: `${kind}/${document.spec.id}.json`,
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

    function statusListKeyChainItem(result: ConfigImportPlan) {
        return result.items.find(
            (item) =>
                item.kind === "KeyChain" && item.id === statusListKeyChain,
        );
    }

    beforeAll(async () => {
        app = await createApp();
        auth = `Bearer ${await tenantToken(app, tenant, [
            Role.Issuances,
            Role.Keys,
        ])}`;

        // The bundle source takes over both key chains.
        const takeOver = bundleOf(["attestation", "status-list"]);
        const takeOverPlan = await plan(takeOver, "upsert");
        expect(takeOverPlan.applicable, JSON.stringify(takeOverPlan)).toBe(
            true,
        );
        await api()
            .post(
                `/config-bundles/import?mode=upsert&planFingerprint=${takeOverPlan.planFingerprint}`,
            )
            .set("Authorization", auth)
            .send(takeOver)
            .expect(201);

        // A status list created through the API, outside any bundle.
        const statusList = await api()
            .post("/status-lists")
            .set("Authorization", auth)
            .send({ keyChainId: statusListKeyChain })
            .expect(201);
        statusListId = statusList.body.id;
    });

    afterAll(async () => {
        await app?.close();
    });

    test("blocks deleting a key chain that a stored configuration names", async () => {
        const result = await plan(bundleOf(["attestation"]), "replace");

        expect(result.applicable).toBe(false);
        const item = statusListKeyChainItem(result);
        expect(item?.action).toBe("blocked");
        expect(item?.issues).toEqual([
            {
                severity: "error",
                code: "KEY_CHAIN_IN_USE",
                path: "/spec/id",
                message: `Key chain "${statusListKeyChain}" is left out of this import, so replace mode deletes it, but it is still used by 1 status list ("${statusListId}"). Keep the key chain in the bundle or folder, or remove these references.`,
                resource: { kind: "KeyChain", id: statusListKeyChain },
            },
        ]);
        expect(result.issues).toContainEqual(item?.issues[0]);
    });

    test("unblocks the delete when the bundle rewrites the configuration without the key chain", async () => {
        const result = await plan(
            bundleOf(
                ["attestation"],
                [
                    {
                        kind: "StatusList",
                        document: document("StatusList", { id: statusListId }),
                    },
                ],
            ),
            "replace",
        );

        expect(statusListKeyChainItem(result)).toMatchObject({
            action: "delete",
            issues: [],
        });
    });

    test("blocks the delete when a document of the bundle names the key chain", async () => {
        const result = await plan(
            bundleOf(
                ["attestation"],
                [
                    {
                        kind: "StatusList",
                        document: document("StatusList", {
                            id: statusListId,
                            keyChainId: statusListKeyChain,
                        }),
                    },
                ],
            ),
            "replace",
        );

        expect(result.applicable).toBe(false);
        expect(statusListKeyChainItem(result)?.issues).toContainEqual(
            expect.objectContaining({
                code: "KEY_CHAIN_IN_USE",
                message: expect.stringContaining(
                    `still used by 1 status list ("${statusListId}")`,
                ),
            }),
        );
    });

    test("deletes the key chain once nothing names it", async () => {
        await api()
            .delete(`/status-lists/${statusListId}`)
            .set("Authorization", auth)
            .expect(204);

        const result = await plan(bundleOf(["attestation"]), "replace");

        expect(result.applicable, JSON.stringify(result.issues)).toBe(true);
        expect(statusListKeyChainItem(result)).toMatchObject({
            action: "delete",
            issues: [],
        });
    });

    test("counts the stored key chain of a trust list the bundle rewrites without keyChainId", async () => {
        const takeOver = bundleOf(["attestation", "status-list", "trust-list"]);
        const takeOverPlan = await plan(takeOver, "upsert");
        expect(takeOverPlan.applicable, JSON.stringify(takeOverPlan)).toBe(
            true,
        );
        await api()
            .post(
                `/config-bundles/import?mode=upsert&planFingerprint=${takeOverPlan.planFingerprint}`,
            )
            .set("Authorization", auth)
            .send(takeOver)
            .expect(201);
        const entities = [
            {
                type: "internal",
                issuerKeyChainId: attestationKeyChain,
                revocationKeyChainId: statusListKeyChain,
                info: { name: "Provider" },
            },
        ];
        // Without keyChainId, the list takes the tenant's trust list key chain.
        await api()
            .post("/trust-list")
            .set("Authorization", auth)
            .send({ id: "tl-b", entities })
            .expect(201);

        const result = await plan(
            bundleOf(
                ["attestation", "status-list"],
                [
                    {
                        kind: "TrustList",
                        document: document("TrustList", {
                            id: "tl-b",
                            entities,
                        }),
                    },
                ],
            ),
            "replace",
        );

        const item = result.items.find(
            (candidate) =>
                candidate.kind === "KeyChain" &&
                candidate.id === trustListKeyChain,
        );
        expect(item?.action).toBe("blocked");
        expect(item?.issues).toContainEqual(
            expect.objectContaining({
                code: "KEY_CHAIN_IN_USE",
                message: expect.stringContaining('1 trust list ("tl-b")'),
            }),
        );
    });
});
