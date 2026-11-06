import "reflect-metadata";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import request from "supertest";
import type { App } from "supertest/types";
import type { Repository } from "typeorm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { Role } from "../../src/auth/roles/role.enum.js";
import type { KeyChainImportDto } from "../../src/crypto/key/dto/key-chain-import.dto.js";
import type { TrustListEntity } from "../../src/issuer/trust-list/dto/trust-list-create.dto.js";
import { TrustList } from "../../src/issuer/trust-list/entities/trust-list.entity.js";
import type {
    ConfigBundle,
    ConfigImportPlan,
} from "../../src/platform/config-portability/config-resource.types.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import {
    type BundleDocument,
    documentsBundle,
} from "../shared/config-bundle.js";
import { getTenantAdminToken, readConfig } from "../utils.js";

const tenant = "trust-list-entity-key-chains";
const trustListKeyChain = "570852d7-7e7f-40af-a0e3-a6ebffd75ed0";
const attestationKeyChain = "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad";
const statusListKeyChain = "1f8c6b29-a4d3-4e7f-b2a0-9c5d13e8f746";

function internal(
    issuerKeyChainId: string,
    revocationKeyChainId: string,
): TrustListEntity {
    return {
        type: "internal",
        issuerKeyChainId,
        revocationKeyChainId,
        info: { name: "Provider" },
    };
}

function trustListDocument(
    id: string,
    entities: TrustListEntity[],
    description?: string,
): BundleDocument {
    return {
        kind: "TrustList",
        id,
        path: `trust-lists/${id}.json`,
        spec: { id, description, keyChainId: trustListKeyChain, entities },
    };
}

function trustListBundle(
    id: string,
    entities: TrustListEntity[],
    description?: string,
): ConfigBundle {
    return documentsBundle(tenant, [
        trustListDocument(id, entities, description),
    ]);
}

/**
 * Internal trust list entities publish the certificate of the key chain in
 * `issuerKeyChainId` as issuance service and the one in `revocationKeyChainId`
 * as revocation service, so these must be key chains that sign credentials
 * and status lists of the tenant.
 */
describe("Trust list entity key chain usage types (e2e)", () => {
    let app: INestApplication<App>;
    let auth: string;
    const api = () => request(app.getHttpServer());

    function saveTrustList(
        method: "post" | "put",
        id: string,
        entities: TrustListEntity[],
        description?: string,
    ) {
        return api()
            [method](method === "post" ? "/trust-list" : `/trust-list/${id}`)
            .set("Authorization", auth)
            .send({ id, description, keyChainId: trustListKeyChain, entities });
    }

    async function plan(
        bundle: ConfigBundle,
        mode: "create" | "upsert" = "upsert",
    ): Promise<ConfigImportPlan> {
        const response = await api()
            .post(`/config-bundles/plan?mode=${mode}`)
            .set("Authorization", auth)
            .send(bundle)
            .expect(201);
        return response.body;
    }

    /**
     * A list stored before 10.0, whose internal entity names the status list
     * key chain as issuer: written to the database, as the API refuses it.
     */
    async function storeListFromBeforeTheCheck(id: string): Promise<void> {
        await saveTrustList("post", id, [
            internal(attestationKeyChain, statusListKeyChain),
        ]).expect(201);
        await app
            .get<Repository<TrustList>>(getRepositoryToken(TrustList))
            .update(
                { tenantId: tenant, id },
                {
                    entityConfig: [
                        internal(statusListKeyChain, statusListKeyChain),
                    ],
                },
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
        const fixtures = resolve(__dirname, "../fixtures/haip");
        for (const file of ["trust-list", "attestation", "status-list"]) {
            await api()
                .post("/key-chain/import")
                .set("Authorization", auth)
                .send(
                    readConfig<KeyChainImportDto>(
                        join(fixtures, `key-chains/${file}.json`),
                    ),
                )
                .expect(201);
        }
    });

    afterAll(async () => {
        await app?.close();
    });

    test("refuses key chains of other usage types with an issue at each field", async () => {
        const response = await saveTrustList("post", "swapped", [
            internal(attestationKeyChain, statusListKeyChain),
            internal(statusListKeyChain, trustListKeyChain),
        ]).expect(400);

        expect(response.body.message).toBe("Validation failed");
        expect(response.body.errors).toEqual([
            {
                path: ["entities", 1, "issuerKeyChainId"],
                code: "key_chain_usage_mismatch",
                message: `Key chain "${statusListKeyChain}" has usage type "statusList"; issuerKeyChainId needs a key chain with usage type "attestation".`,
            },
            {
                path: ["entities", 1, "revocationKeyChainId"],
                code: "key_chain_usage_mismatch",
                message: `Key chain "${trustListKeyChain}" has usage type "trustList"; revocationKeyChainId needs a key chain with usage type "statusList" or "attestation".`,
            },
        ]);
        await api()
            .get("/trust-list/swapped")
            .set("Authorization", auth)
            .expect(404);
    });

    test("refuses a key chain that does not exist at its field", async () => {
        const response = await saveTrustList("post", "unknown-key-chain", [
            internal("does-not-exist", statusListKeyChain),
        ]).expect(400);

        expect(response.body.errors).toEqual([
            {
                path: ["entities", 0, "issuerKeyChainId"],
                code: "key_chain_not_found",
                message: 'Key chain "does-not-exist" does not exist.',
            },
        ]);
    });

    test("accepts the attestation key chain for revocation, as status lists fall back to it", async () => {
        const response = await saveTrustList("post", "fallback", [
            internal(attestationKeyChain, attestationKeyChain),
        ]).expect(201);

        const [entity] = response.body.data.LoTE.TrustedEntitiesList;
        const certificates = entity.TrustedEntityServices.map(
            (service: any) =>
                service.ServiceInformation.ServiceDigitalIdentity
                    .X509Certificates[0].val,
        );
        expect(certificates).toHaveLength(2);
        expect(certificates[1]).toBe(certificates[0]);
    });

    test("keeps a value the stored list already has and refuses a new one", async () => {
        await storeListFromBeforeTheCheck("stored");

        await saveTrustList(
            "put",
            "stored",
            [internal(statusListKeyChain, statusListKeyChain)],
            "Description changed",
        ).expect(200);

        const before = await api()
            .get("/trust-list/stored")
            .set("Authorization", auth)
            .expect(200);
        const changed = await saveTrustList("put", "stored", [
            internal(statusListKeyChain, trustListKeyChain),
        ]).expect(400);
        expect(changed.body.errors).toEqual([
            expect.objectContaining({
                path: ["entities", 0, "revocationKeyChainId"],
                code: "key_chain_usage_mismatch",
            }),
        ]);
        // A refused update publishes nothing.
        const after = await api()
            .get("/trust-list/stored")
            .set("Authorization", auth)
            .expect(200);
        expect(after.body.sequenceNumber).toBe(before.body.sequenceNumber);
        expect(after.body.entityConfig).toEqual(before.body.entityConfig);
    });

    test("blocks the import plan of a list with a key chain of another usage type", async () => {
        const result = await plan(
            trustListBundle("planned", [
                internal(statusListKeyChain, statusListKeyChain),
            ]),
        );

        expect(result.applicable).toBe(false);
        expect(result.issues).toContainEqual(
            expect.objectContaining({
                severity: "error",
                code: "KEY_CHAIN_USAGE_MISMATCH",
                path: "/spec/entities/0/issuerKeyChainId",
                resource: { kind: "TrustList", id: "planned" },
            }),
        );
        expect(
            result.issues.filter(
                (issue) => issue.code === "KEY_CHAIN_USAGE_MISMATCH",
            ),
        ).toHaveLength(1);
    });

    test("warns about a value the stored list already has and applies the import", async () => {
        await storeListFromBeforeTheCheck("stored-import");
        // The folder changes another field and keeps the 9.x entity.
        const bundle = trustListBundle(
            "stored-import",
            [internal(statusListKeyChain, statusListKeyChain)],
            "Changed by the import",
        );

        const result = await plan(bundle);

        expect(result.applicable, JSON.stringify(result.issues)).toBe(true);
        expect(
            result.items.find(
                (item) =>
                    item.kind === "TrustList" && item.id === "stored-import",
            )?.action,
        ).toBe("update");
        expect(result.issues).toContainEqual(
            expect.objectContaining({
                severity: "warning",
                code: "KEY_CHAIN_USAGE_MISMATCH",
                path: "/spec/entities/0/issuerKeyChainId",
                resource: { kind: "TrustList", id: "stored-import" },
            }),
        );
        await api()
            .post(
                `/config-bundles/import?mode=upsert&planFingerprint=${result.planFingerprint}`,
            )
            .set("Authorization", auth)
            .send(bundle)
            .expect(201);
        const stored = await api()
            .get("/trust-list/stored-import")
            .set("Authorization", auth)
            .expect(200);
        expect(stored.body.description).toBe("Changed by the import");
    });

    test("only warns about a list the import skips", async () => {
        // Fixed through the API, while the folder still has the old value.
        await saveTrustList("post", "skipped", [
            internal(attestationKeyChain, statusListKeyChain),
        ]).expect(201);

        const result = await plan(
            trustListBundle("skipped", [
                internal(statusListKeyChain, statusListKeyChain),
            ]),
            "create",
        );

        expect(result.applicable, JSON.stringify(result.issues)).toBe(true);
        expect(
            result.items.find(
                (item) => item.kind === "TrustList" && item.id === "skipped",
            )?.action,
        ).toBe("skip");
        expect(result.issues).toContainEqual(
            expect.objectContaining({
                severity: "warning",
                code: "KEY_CHAIN_USAGE_MISMATCH",
                path: "/spec/entities/0/issuerKeyChainId",
            }),
        );
    });

    test("reports a missing key chain only as a missing reference", async () => {
        const result = await plan(
            trustListBundle("unknown", [
                internal("does-not-exist", statusListKeyChain),
            ]),
        );

        expect(result.applicable).toBe(false);
        expect(result.issues).toContainEqual(
            expect.objectContaining({
                code: "MISSING_RESOURCE_REFERENCE",
                path: "/spec/entities/0/issuerKeyChainId",
            }),
        );
        expect(
            result.issues.filter(
                (issue) => issue.code === "KEY_CHAIN_USAGE_MISMATCH",
            ),
        ).toEqual([]);
    });

    test("reads the usage type of a key chain that only the bundle brings", async () => {
        // As on a new database, where the folder brings its key chains.
        const keyChain = (usageType: string): BundleDocument => {
            const { spec } = readConfig<{ spec: Record<string, unknown> }>(
                join(
                    resolve(__dirname, "../fixtures/haip"),
                    "key-chains/status-list.json",
                ),
            );
            return {
                kind: "KeyChain",
                id: "bundled",
                path: "key-chains/bundled.json",
                spec: { ...spec, id: "bundled", usageType },
            };
        };
        const list = trustListDocument("bundled-issuer", [
            internal("bundled", statusListKeyChain),
        ]);

        const refused = await plan(
            documentsBundle(tenant, [keyChain("statusList"), list]),
        );
        expect(refused.applicable).toBe(false);
        expect(
            refused.issues.filter(
                (issue) => issue.code === "KEY_CHAIN_USAGE_MISMATCH",
            ),
        ).toEqual([
            expect.objectContaining({
                severity: "error",
                path: "/spec/entities/0/issuerKeyChainId",
                resource: { kind: "TrustList", id: "bundled-issuer" },
            }),
        ]);

        const accepted = await plan(
            documentsBundle(tenant, [keyChain("attestation"), list]),
        );
        expect(
            accepted.issues.filter(
                (issue) => issue.code === "KEY_CHAIN_USAGE_MISMATCH",
            ),
        ).toEqual([]);
    });

    test("ignores the usage type of a key chain document the plan skips", async () => {
        // Create mode skips the stored status list key chain, so a bundle
        // that gives it attestation usage does not make it an issuer.
        const { spec } = JSON.parse(
            readFileSync(
                join(
                    resolve(__dirname, "../fixtures/haip"),
                    "key-chains/status-list.json",
                ),
                "utf8",
            ),
        ) as { spec: Record<string, unknown> };
        const result = await plan(
            documentsBundle(tenant, [
                {
                    kind: "KeyChain",
                    id: statusListKeyChain,
                    path: `key-chains/${statusListKeyChain}.json`,
                    spec: {
                        ...spec,
                        id: statusListKeyChain,
                        usageType: "attestation",
                    },
                    // Above the stored generation, so only create mode skips it.
                    generation: 100,
                },
                trustListDocument("skipped-key-chain", [
                    internal(statusListKeyChain, statusListKeyChain),
                ]),
            ]),
            "create",
        );

        expect(
            result.items.find(
                (item) =>
                    item.kind === "KeyChain" && item.id === statusListKeyChain,
            )?.action,
        ).toBe("skip");
        expect(result.applicable).toBe(false);
        expect(result.issues).toContainEqual(
            expect.objectContaining({
                severity: "error",
                code: "KEY_CHAIN_USAGE_MISMATCH",
                path: "/spec/entities/0/issuerKeyChainId",
                resource: { kind: "TrustList", id: "skipped-key-chain" },
            }),
        );
    });
});
