import { createHash, generateKeyPairSync } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import * as x509 from "@peculiar/x509";
import type { JWK } from "jose";
import request from "supertest";
import { v4 } from "uuid";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { Role } from "../../src/auth/roles/role.enum.js";
import { EncryptionService } from "../../src/crypto/encryption/encryption.service.js";
import { MDL_DOCUMENT_SIGNER_EKU } from "../../src/crypto/key/domain/signing-certificate-profile.js";
import { KeyChainType } from "../../src/crypto/key/dto/key-chain-create.dto.js";
import { KeyChainImportDto } from "../../src/crypto/key/dto/key-chain-import.dto.js";
import { KeyUsageType } from "../../src/crypto/key/types/key-usage-type.js";
import { ConfigOwnershipService } from "../../src/platform/config-portability/config-ownership.service.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { clientToken, getTenantAdminToken, getToken } from "../utils.js";
import { createSelfSignedCa, expectCertificateSignedBy } from "../utils-ec.js";

describe("Key Chain — Import (e2e)", () => {
    let app: INestApplication;
    let authToken: string;
    let tenantAdminToken: string;
    const tenantAdminTenantId = "key-export-admin";

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(createAppValidationPipe());
        await app.init();

        const configService = app.get(ConfigService);
        const clientId = configService.getOrThrow<string>("AUTH_CLIENT_ID");
        const clientSecret =
            configService.getOrThrow<string>("AUTH_CLIENT_SECRET");
        authToken = await getToken(app, clientId, clientSecret);

        // A second tenant whose client holds tenant:admin, the role that is
        // allowed to export private key material.
        tenantAdminToken = await getTenantAdminToken(
            app,
            clientId,
            clientSecret,
            tenantAdminTenantId,
        );
    });

    const privateKey = {
        kty: "EC",
        x: "pmn8SKQKZ0t2zFlrUXzJaJwwQ0WnQxcSYoS_D6ZSGho",
        y: "rMd9JTAovcOI_OvOXWCWZ1yVZieVYK2UgvB2IPuSk2o",
        crv: "P-256",
        d: "rqv47L1jWkbFAGMCK8TORQ1FknBUYGY6OLU1dYHNDqU",
        alg: "ES256",
    };

    async function importKeyChain(token: string): Promise<string> {
        const keyId = v4();
        await request(app.getHttpServer())
            .post("/key-chain/import")
            .set("Authorization", `Bearer ${token}`)
            .send({
                id: keyId,
                key: { ...privateKey, kid: keyId },
                usageType: KeyUsageType.Attestation,
            } satisfies KeyChainImportDto)
            .expect(201);
        return keyId;
    }

    afterAll(async () => {
        await app?.close();
    });

    test("import a new key chain", async () => {
        const keyId = v4();
        const privateKey = {
            kty: "EC",
            x: "pmn8SKQKZ0t2zFlrUXzJaJwwQ0WnQxcSYoS_D6ZSGho",
            y: "rMd9JTAovcOI_OvOXWCWZ1yVZieVYK2UgvB2IPuSk2o",
            crv: "P-256",
            d: "rqv47L1jWkbFAGMCK8TORQ1FknBUYGY6OLU1dYHNDqU",
            kid: keyId,
            alg: "ES256",
        };

        const payload: KeyChainImportDto = {
            id: keyId,
            key: privateKey,
            usageType: KeyUsageType.Attestation,
            description: "Test key chain",
        };
        const creationResponse = await request(app.getHttpServer())
            .post("/key-chain/import")
            .set("Authorization", `Bearer ${authToken}`)
            .send(payload)
            .expect(201);

        expect(creationResponse.body.id).toBe(keyId);

        const getResponse = await request(app.getHttpServer())
            .get("/key-chain")
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        const foundKeyChain = getResponse.body.find(
            (keyChain) => keyChain.id === keyId,
        );
        expect(foundKeyChain).toBeDefined();
        expect(
            getResponse.body.some(
                (keyChain) => keyChain.usageType === KeyUsageType.Encrypt,
            ),
        ).toBe(false);

        // The detail view returns the public key as a usable JWK.
        const { d: _d, ...publicKey } = privateKey;
        const keyChainResponse = await request(app.getHttpServer())
            .get(`/key-chain/${keyId}`)
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        expect(keyChainResponse.body.activePublicKey).toEqual(publicKey);
    });

    describe("export", () => {
        test("rejects callers that only manage issuance or presentation resources", async () => {
            const keyId = await importKeyChain(authToken);

            const response = await request(app.getHttpServer())
                .get(`/key-chain/${keyId}/export`)
                .set("Authorization", `Bearer ${authToken}`)
                .expect(403);

            expect(JSON.stringify(response.body)).not.toContain(privateKey.d);
        });

        test("returns the private key to tenant administrators", async () => {
            const keyId = await importKeyChain(tenantAdminToken);

            const response = await request(app.getHttpServer())
                .get(`/key-chain/${keyId}/export`)
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .expect(200);

            expect(response.body.id).toBe(keyId);
            expect(response.body.key.d).toBe(privateKey.d);
        });

        test("re-imports the export of a key chain created without a description", async () => {
            const created = await request(app.getHttpServer())
                .post("/key-chain")
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .send({
                    usageType: KeyUsageType.Attestation,
                    type: "internalChain",
                    rotationPolicy: { enabled: true, intervalDays: 90 },
                })
                .expect(201);
            const keyId = created.body.id;

            const exported = await request(app.getHttpServer())
                .get(`/key-chain/${keyId}/export`)
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .expect(200);

            expect(exported.body).not.toHaveProperty("description");
            expect(exported.body.rotationPolicy).not.toHaveProperty(
                "certValidityDays",
            );

            await request(app.getHttpServer())
                .delete(`/key-chain/${keyId}`)
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .expect(204);
            const reimported = await request(app.getHttpServer())
                .post("/key-chain/import")
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .send(exported.body)
                .expect(201);

            expect(reimported.body.id).toBe(keyId);
            const keyChain = await request(app.getHttpServer())
                .get(`/key-chain/${keyId}`)
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .expect(200);
            expect(keyChain.body.type).toBe("internalChain");
            expect(keyChain.body.rootCertificate.pem).toBe(
                exported.body.crt[0],
            );
        });

        test("re-imports the export of an internal chain without rotation", async () => {
            const created = await request(app.getHttpServer())
                .post("/key-chain")
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .send({
                    usageType: KeyUsageType.Attestation,
                    type: "internalChain",
                })
                .expect(201);
            const keyId = created.body.id;
            const original = await request(app.getHttpServer())
                .get(`/key-chain/${keyId}`)
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .expect(200);

            const exported = await request(app.getHttpServer())
                .get(`/key-chain/${keyId}/export`)
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .expect(200);

            expect(exported.body).toMatchObject({
                type: "internalChain",
                crt: [original.body.rootCertificate.pem],
            });
            expect(exported.body).not.toHaveProperty("rotationPolicy");

            await request(app.getHttpServer())
                .delete(`/key-chain/${keyId}`)
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .expect(204);
            await request(app.getHttpServer())
                .post("/key-chain/import")
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .send(exported.body)
                .expect(201);

            const reimported = await request(app.getHttpServer())
                .get(`/key-chain/${keyId}`)
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .expect(200);
            expect(reimported.body).toMatchObject({
                type: "internalChain",
                rootCertificate: { pem: original.body.rootCertificate.pem },
                activeCertificate: {
                    subject: original.body.activeCertificate.subject,
                    issuer: original.body.rootCertificate.subject,
                },
                rotationPolicy: { enabled: false },
            });
            // The signing key is new; the root key is not used for signing.
            expect(reimported.body.activePublicKey.kid).not.toBe(
                exported.body.key.kid,
            );

            const reexported = await request(app.getHttpServer())
                .get(`/key-chain/${keyId}/export`)
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .expect(200);
            expect(reexported.body).toMatchObject({
                type: "internalChain",
                key: exported.body.key,
                crt: exported.body.crt,
            });
        });

        test("imports a CA key without certificate as an internal chain", async () => {
            const keyId = v4();
            await request(app.getHttpServer())
                .post("/key-chain/import")
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .send({
                    id: keyId,
                    key: { ...privateKey, kid: `${keyId}-root` },
                    usageType: KeyUsageType.Attestation,
                    type: "internalChain",
                } satisfies KeyChainImportDto)
                .expect(201);

            const keyChain = await request(app.getHttpServer())
                .get(`/key-chain/${keyId}`)
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .expect(200);
            expect(keyChain.body).toMatchObject({
                type: "internalChain",
                activeCertificate: {
                    issuer: keyChain.body.rootCertificate.subject,
                },
                rotationPolicy: { enabled: false },
            });
            expect(keyChain.body.activePublicKey.kid).not.toBe(`${keyId}-root`);
            // An attestation leaf follows the ISO/IEC 18013-5 document
            // signer profile.
            const eku = new x509.X509Certificate(
                keyChain.body.activeCertificate.pem,
            ).getExtension(x509.ExtendedKeyUsageExtension);
            expect(eku?.usages).toEqual([MDL_DOCUMENT_SIGNER_EKU]);
            expect(eku?.critical).toBe(true);
        });

        test("rejects an unknown key chain type", async () => {
            const response = await request(app.getHttpServer())
                .post("/key-chain/import")
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .send({
                    key: privateKey,
                    usageType: KeyUsageType.Attestation,
                    type: "externalChain",
                })
                .expect(400);
            expect(JSON.stringify(response.body)).toContain("type");
        });

        test("re-imports the export of a standalone key chain with rotation enabled", async () => {
            const created = await request(app.getHttpServer())
                .post("/key-chain")
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .send({
                    usageType: KeyUsageType.Attestation,
                    type: "standalone",
                    rotationPolicy: { enabled: true, intervalDays: 90 },
                })
                .expect(201);
            const keyId = created.body.id;
            const original = await request(app.getHttpServer())
                .get(`/key-chain/${keyId}`)
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .expect(200);

            const exported = await request(app.getHttpServer())
                .get(`/key-chain/${keyId}/export`)
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .expect(200);

            expect(exported.body.crt).toHaveLength(1);
            expect(exported.body.rotationPolicy).toEqual({
                enabled: true,
                intervalDays: 90,
            });

            await request(app.getHttpServer())
                .delete(`/key-chain/${keyId}`)
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .expect(204);
            await request(app.getHttpServer())
                .post("/key-chain/import")
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .send(exported.body)
                .expect(201);

            const reimported = await request(app.getHttpServer())
                .get(`/key-chain/${keyId}`)
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .expect(200);
            expect(exported.body.type).toBe("standalone");
            expect(reimported.body).toMatchObject({
                type: "standalone",
                activePublicKey: original.body.activePublicKey,
                activeCertificate: { pem: original.body.activeCertificate.pem },
                rotationPolicy: { enabled: true, intervalDays: 90 },
            });
            expect(reimported.body.rotationPolicy.nextRotationAt).toBeDefined();
            expect(reimported.body).not.toHaveProperty("rootCertificate");

            const reexported = await request(app.getHttpServer())
                .get(`/key-chain/${keyId}/export`)
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .expect(200);
            expect(reexported.body.key).toEqual(exported.body.key);
            expect(reexported.body.crt).toEqual(exported.body.crt);
        });

        test("does not export key chains of another tenant", async () => {
            const keyId = await importKeyChain(authToken);

            await request(app.getHttpServer())
                .get(`/key-chain/${keyId}/export`)
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .expect(404);
        });
    });

    describe("rotation policy", () => {
        test("rejects enabling rotation without an interval", async () => {
            const response = await request(app.getHttpServer())
                .post("/key-chain")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    usageType: KeyUsageType.Attestation,
                    type: "standalone",
                    rotationPolicy: { enabled: true },
                })
                .expect(400);
            expect(JSON.stringify(response.body)).toContain("intervalDays");

            const created = await request(app.getHttpServer())
                .post("/key-chain")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    usageType: KeyUsageType.Attestation,
                    type: "standalone",
                })
                .expect(201);
            await request(app.getHttpServer())
                .put(`/key-chain/${created.body.id}`)
                .set("Authorization", `Bearer ${authToken}`)
                .send({ rotationPolicy: { enabled: true } })
                .expect(400);
            await request(app.getHttpServer())
                .put(`/key-chain/${created.body.id}`)
                .set("Authorization", `Bearer ${authToken}`)
                .send({ rotationPolicy: { enabled: true, intervalDays: 30 } })
                .expect(204);
        });
    });

    describe("tenant encryption key chain: key chain API and configuration bundles", () => {
        // A tenant of its own, so a failing guard cannot break the
        // decryption key of tenants that other tests use.
        const guardedTenantId = "key-encryption-guard";
        let guardedAdminToken: string;
        let issuanceManagerToken: string;
        let guarded: { id: string; privateJwk: JWK };

        /**
         * The tenant's encryption key chain as the decryption code uses it.
         * Its id is public: it is the `kid` of the published encryption JWK.
         */
        async function encryptionKeyChain(tenantId: string) {
            const encryption = app.get(EncryptionService);
            return {
                id: (await encryption.getEncryptionPublicKey(tenantId)).kid!,
                privateJwk: await encryption.getEncryptionPrivateJwk(tenantId),
            };
        }

        function keyChainBundle(spec: Record<string, unknown>) {
            const document = {
                $schema:
                    "https://eudiplo.dev/schemas/v1/KeyChainConfigFile.schema.json",
                metadata: { generation: 1 },
                spec,
            };
            return {
                manifest: {
                    format: "eudiplo.config-bundle",
                    formatVersion: 2,
                    sourceVersion: "key-import",
                    exportedAt: new Date(0).toISOString(),
                    tenant: tenantAdminTenantId,
                    resources: [
                        {
                            kind: "KeyChain",
                            id: spec.id,
                            $schema: document.$schema,
                            path: `key-chains/${spec.id}.json`,
                            sha256: createHash("sha256")
                                .update(JSON.stringify(document))
                                .digest("hex"),
                            ownership: "unmanaged",
                            generation: 1,
                        },
                    ],
                    assets: [],
                    requirements: [],
                    warnings: [],
                },
                documents: [document],
                assets: [],
            };
        }

        beforeAll(async () => {
            const configService = app.get(ConfigService);
            guardedAdminToken = await getTenantAdminToken(
                app,
                configService.getOrThrow<string>("AUTH_CLIENT_ID"),
                configService.getOrThrow<string>("AUTH_CLIENT_SECRET"),
                guardedTenantId,
                [Role.Clients, Role.Issuances],
            );
            issuanceManagerToken = await clientToken(
                app,
                guardedAdminToken,
                `key-chain-issuance-manager-${v4()}`,
                [Role.Issuances],
            );
            guarded = await encryptionKeyChain(guardedTenantId);
        });

        test.each([KeyUsageType.Encrypt, KeyUsageType.Attestation])(
            "import with its id and usageType %s does not replace it",
            async (usageType) => {
                await request(app.getHttpServer())
                    .post("/key-chain/import")
                    .set("Authorization", `Bearer ${issuanceManagerToken}`)
                    .send({
                        id: guarded.id,
                        key: privateKey,
                        usageType,
                    } satisfies KeyChainImportDto)
                    .expect(409);

                expect(await encryptionKeyChain(guardedTenantId)).toEqual(
                    guarded,
                );
            },
        );

        test("stays the decryption key when a key chain with usage type encrypt is created", async () => {
            await request(app.getHttpServer())
                .post("/key-chain")
                .set("Authorization", `Bearer ${issuanceManagerToken}`)
                .send({ usageType: KeyUsageType.Encrypt, type: "standalone" })
                .expect(201);

            expect(await encryptionKeyChain(guardedTenantId)).toEqual(guarded);
        });

        test("can be read without private key material", async () => {
            const response = await request(app.getHttpServer())
                .get(`/key-chain/${guarded.id}`)
                .set("Authorization", `Bearer ${issuanceManagerToken}`)
                .expect(200);

            expect(response.body.usageType).toBe(KeyUsageType.Encrypt);
            expect(JSON.stringify(response.body)).not.toContain(
                guarded.privateJwk.d,
            );
        });

        test("update, rotate and delete do not find it", async () => {
            const server = app.getHttpServer();
            const auth = `Bearer ${issuanceManagerToken}`;

            await request(server)
                .put(`/key-chain/${guarded.id}`)
                .set("Authorization", auth)
                .send({ description: "replaced" })
                .expect(404);
            await request(server)
                .post(`/key-chain/${guarded.id}/rotate`)
                .set("Authorization", auth)
                .expect(404);
            await request(server)
                .delete(`/key-chain/${guarded.id}`)
                .set("Authorization", auth)
                .expect(404);

            expect(await encryptionKeyChain(guardedTenantId)).toEqual(guarded);
        });

        test("export does not find it for tenant administrators", async () => {
            const own = await encryptionKeyChain(tenantAdminTenantId);

            const response = await request(app.getHttpServer())
                .get(`/key-chain/${own.id}/export`)
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .expect(404);

            expect(JSON.stringify(response.body)).not.toContain(
                own.privateJwk.d,
            );
        });

        test("configuration bundle export leaves it out", async () => {
            const own = await encryptionKeyChain(tenantAdminTenantId);

            const response = await request(app.getHttpServer())
                .get("/config-bundles/export")
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .expect(200);

            expect(JSON.stringify(response.body)).not.toContain(own.id);
        });

        test.each([
            {
                mode: "upsert",
                keySource: { type: "private-jwk", jwk: privateKey },
            },
            // As exported by earlier versions.
            {
                mode: "create",
                keySource: {
                    type: "required",
                    publicJwk: {
                        kty: privateKey.kty,
                        crv: privateKey.crv,
                        x: privateKey.x,
                        y: privateKey.y,
                    },
                },
            },
        ])(
            "configuration bundle import in $mode mode skips it",
            async ({ mode, keySource }) => {
                const own = await encryptionKeyChain(tenantAdminTenantId);
                const bundle = keyChainBundle({
                    id: own.id,
                    usageType: KeyUsageType.Encrypt,
                    keySource,
                });

                const planned = await request(app.getHttpServer())
                    .post(`/config-bundles/plan?mode=${mode}`)
                    .set("Authorization", `Bearer ${tenantAdminToken}`)
                    .send(bundle)
                    .expect(201);
                expect(planned.body.applicable).toBe(true);
                expect(planned.body.items[0].changes).toBeUndefined();
                expect(planned.body.items[0]).toMatchObject({
                    kind: "KeyChain",
                    id: own.id,
                    action: "skip",
                    issues: [
                        expect.objectContaining({
                            severity: "warning",
                            code: "KEY_CHAIN_ID_RESERVED",
                        }),
                    ],
                });

                await request(app.getHttpServer())
                    .post(
                        `/config-bundles/import?mode=${mode}&planFingerprint=${planned.body.planFingerprint}`,
                    )
                    .set("Authorization", `Bearer ${tenantAdminToken}`)
                    .send(bundle)
                    .expect(201);

                expect(await encryptionKeyChain(tenantAdminTenantId)).toEqual(
                    own,
                );
            },
        );

        test("configuration bundle import skips it even if the API changed it before", async () => {
            // 9.x let the key chain API change it, which raised its generation.
            await app
                .get(ConfigOwnershipService)
                .recordApiMutation(
                    guardedTenantId,
                    "KeyChain",
                    guarded.id,
                    false,
                );
            const bundle = keyChainBundle({
                id: guarded.id,
                usageType: KeyUsageType.Encrypt,
                keySource: { type: "private-jwk", jwk: privateKey },
            });

            const planned = await request(app.getHttpServer())
                .post("/config-bundles/plan?mode=upsert")
                .set("Authorization", `Bearer ${guardedAdminToken}`)
                .send(bundle)
                .expect(201);

            expect(planned.body.applicable).toBe(true);
            expect(planned.body.items[0].action).toBe("skip");
            expect(
                planned.body.items[0].issues.map(
                    (issue: { code: string }) => issue.code,
                ),
            ).toEqual(["KEY_CHAIN_ID_RESERVED"]);
        });

        test("configuration bundle import in replace mode does not delete it", async () => {
            // Ownership a 9.x import from this source may have left behind.
            await app.get(ConfigOwnershipService).markApplied({
                tenantId: guardedTenantId,
                kind: "KeyChain",
                resourceId: guarded.id,
                ownership: "file-managed",
                source: `bundle:${tenantAdminTenantId}`,
            });
            const bundle = keyChainBundle({
                id: v4(),
                usageType: KeyUsageType.Attestation,
                keySource: { type: "regenerate" },
            });

            const planned = await request(app.getHttpServer())
                .post("/config-bundles/plan?mode=replace")
                .set("Authorization", `Bearer ${guardedAdminToken}`)
                .send(bundle)
                .expect(201);

            expect(planned.body.items).not.toContainEqual(
                expect.objectContaining({ id: guarded.id }),
            );
        });
    });

    describe("curves", () => {
        const getKeyChain = (id: string) =>
            request(app.getHttpServer())
                .get(`/key-chain/${id}`)
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200);

        test.each([
            ["ES384", "secp384r1", "P-384"],
            ["ES512", "secp521r1", "P-521"],
        ] as const)(
            "imports a %s PKCS#8 PEM key with the algorithm of its curve",
            async (alg, namedCurve, crv) => {
                const keyPem = generateKeyPairSync("ec", { namedCurve })
                    .privateKey.export({ type: "pkcs8", format: "pem" })
                    .toString();
                const id = v4();
                await request(app.getHttpServer())
                    .post("/key-chain/import")
                    .set("Authorization", `Bearer ${authToken}`)
                    .send({
                        id,
                        keyPem,
                        usageType: KeyUsageType.Attestation,
                    } satisfies KeyChainImportDto)
                    .expect(201);

                const keyChain = await getKeyChain(id);
                expect(keyChain.body.alg).toBe(alg);
                expect(keyChain.body.activePublicKey).toMatchObject({
                    crv,
                    alg,
                });
                expect(keyChain.body.activePublicKey).not.toHaveProperty("d");
                expectCertificateSignedBy(
                    keyChain.body.activeCertificate.pem,
                    alg,
                );
            },
        );

        test.each([
            ["RSA", () => generateKeyPairSync("rsa", { modulusLength: 2048 })],
            ["Ed25519", () => generateKeyPairSync("ed25519")],
            [
                "secp256k1",
                () => generateKeyPairSync("ec", { namedCurve: "secp256k1" }),
            ],
        ] as const)("rejects a %s PEM key with 400", async (_name, keys) => {
            const keyPem = keys()
                .privateKey.export({ type: "pkcs8", format: "pem" })
                .toString();
            const response = await request(app.getHttpServer())
                .post("/key-chain/import")
                .set("Authorization", `Bearer ${authToken}`)
                .send({ keyPem, usageType: KeyUsageType.Attestation })
                .expect(400);
            expect(response.body.message).toContain("Unsupported key");
        });

        test("rejects a P-384 JWK whose alg names ES256", async () => {
            const privateJwk = generateKeyPairSync("ec", {
                namedCurve: "secp384r1",
            }).privateKey.export({ format: "jwk" });
            const response = await request(app.getHttpServer())
                .post("/key-chain/import")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    key: { ...privateJwk, alg: "ES256" },
                    usageType: KeyUsageType.Attestation,
                })
                .expect(400);
            expect(response.body.message).toContain("does not match");
        });

        test("an internal chain under a P-384 CA certificate gets a P-384 signing key", async () => {
            const ca = await createSelfSignedCa("ES384");
            const id = v4();
            await request(app.getHttpServer())
                .post("/key-chain/import")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    id,
                    key: ca.privateJwk as KeyChainImportDto["key"],
                    crt: [ca.certificatePem],
                    usageType: KeyUsageType.Attestation,
                    type: KeyChainType.InternalChain,
                } satisfies KeyChainImportDto)
                .expect(201);

            const keyChain = await getKeyChain(id);
            expect(keyChain.body).toMatchObject({
                type: "internalChain",
                alg: "ES384",
                activePublicKey: { crv: "P-384", alg: "ES384" },
            });
            expect(keyChain.body.rootCertificate.pem.trim()).toBe(
                ca.certificatePem.trim(),
            );
            expectCertificateSignedBy(
                keyChain.body.activeCertificate.pem,
                "ES384",
                ca.certificatePem,
            );
        });

        test("rejects a P-384 CA key with a P-256 root certificate", async () => {
            const ca = await createSelfSignedCa("ES384");
            const otherRoot = await createSelfSignedCa("ES256");
            const response = await request(app.getHttpServer())
                .post("/key-chain/import")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    key: ca.privateJwk as KeyChainImportDto["key"],
                    crt: [otherRoot.certificatePem],
                    usageType: KeyUsageType.Attestation,
                    type: KeyChainType.InternalChain,
                } satisfies KeyChainImportDto)
                .expect(400);
            expect(response.body.message).toContain(
                "does not match the provided private key",
            );
        });
    });
});
