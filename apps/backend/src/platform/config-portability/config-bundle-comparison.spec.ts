import { schemaUrl } from "@eudiplo/config-format/config-format.js";
import { hash } from "bcrypt";
import { describe, expect, it } from "vitest";
import { ConfigBundleService } from "./config-bundle.service.js";
import { ConfigDocumentValidationService } from "./config-document-validation.service.js";
import { ConfigResourceRegistry } from "./config-resource.registry.js";
import type { ConfigDocument } from "./config-resource.types.js";

function service(
    current: Record<string, unknown>,
    files: { id: string; filename: string }[] = [],
) {
    const result = Object.create(ConfigBundleService.prototype) as any;
    result.currentSpec = async () => structuredClone(current);
    result.files = { find: async () => files };
    result.registry = new ConfigResourceRegistry();
    result.documentValidationService = Object.create(
        ConfigDocumentValidationService.prototype,
    );
    result.configService = { get: () => false };
    return result as ConfigBundleService;
}
const client: ConfigDocument = {
    $schema: schemaUrl("Client"),
    kind: "Client",
    metadata: {},
    spec: {
        clientId: "client",
        roles: ["clients:manage"],
        secret: "test-secret",
    },
};
describe("configuration comparisons", () => {
    it("compares plaintext client input with its stored hash without revealing either", async () => {
        const current = {
            ...client.spec,
            secret: await hash("test-secret", 4),
        };
        const result = service(current);
        expect(await result.compareDocument("tenant", client)).toEqual({
            unchanged: true,
            changes: [],
        });
        const changed = await result.compareDocument("tenant", {
            ...client,
            spec: { ...client.spec, secret: "changed-secret" },
        });
        expect(changed.unchanged).toBe(false);
        expect(changed.changes).toEqual([
            {
                path: "/spec/secret",
                before: "[redacted]",
                after: "[redacted]",
                redacted: true,
            },
        ]);
    });
    it("compares stored storage URLs with the bundle filenames they serve", async () => {
        const document: ConfigDocument = {
            $schema: schemaUrl("IssuanceConfig"),
            kind: "IssuanceConfig",
            metadata: {},
            spec: {
                display: [{ name: "Issuer", logo: { uri: "company.png" } }],
            },
        };
        const stored = (uri: string) => ({
            display: [{ name: "Issuer", logo: { uri } }],
        });
        const files = [{ id: "569e", filename: "company.png" }];
        expect(
            await service(
                stored("http://localhost:3000/storage/569e"),
                files,
            ).compareDocument("tenant", document),
        ).toEqual({ unchanged: true, changes: [] });
        expect(
            (
                await service(
                    stored("http://localhost:3000/storage/other"),
                    files,
                ).compareDocument("tenant", document)
            ).unchanged,
        ).toBe(false);
    });
    it("preserves omitted update fields while detecting role changes", async () => {
        const result = service({ ...client.spec, description: "Retained" });
        expect((await result.compareDocument("tenant", client)).unchanged).toBe(
            true,
        );
        const changed = await result.compareDocument("tenant", {
            ...client,
            spec: { ...client.spec, roles: ["presentation:request"] },
        });
        expect(changed.unchanged).toBe(false);
        expect(changed.changes).toContainEqual({
            path: "/spec/roles/0",
            before: "clients:manage",
            after: "presentation:request",
        });
    });
    it("does not suppress explicit regeneration", async () => {
        const document: ConfigDocument = {
            $schema: schemaUrl("KeyChain"),
            kind: "KeyChain",
            metadata: {},
            spec: { id: "key", keySource: { type: "regenerate" } },
        };
        expect(
            (await service(document.spec).compareDocument("tenant", document))
                .unchanged,
        ).toBe(false);
    });
    describe("key chains", () => {
        const publicJwk = { kty: "EC", crv: "P-256", x: "x", y: "y" };
        // Use the real stored-spec mapping instead of the stub.
        function storedKeyChain(overrides: Record<string, unknown> = {}) {
            const row = {
                id: "key",
                description: null,
                usageType: "attestation",
                kmsProvider: "vault",
                externalKeyId: "vault-key",
                activeJwk: { ...publicJwk, d: "private" },
                activeCertificate: "cert",
                rotationEnabled: false,
                rotationIntervalDays: null,
                certValidityDays: null,
                hasInternalCa: () => false,
                ...overrides,
            };
            const result = service({}) as any;
            delete result.currentSpec;
            result.repos = {
                keyChains: {
                    findOneBy: async () => row,
                    find: async () => [row],
                },
            };
            return result as ConfigBundleService;
        }
        const keyChain = (spec: Record<string, unknown>): ConfigDocument => ({
            $schema: schemaUrl("KeyChain"),
            kind: "KeyChain",
            metadata: {},
            spec: {
                id: "key",
                usageType: "attestation",
                kmsProvider: "vault",
                keySource: {
                    type: "external-reference",
                    provider: "vault",
                    externalKeyId: "vault-key",
                    publicJwk,
                },
                crt: ["cert"],
                ...spec,
            },
        });

        it("treats a stored null key chain description like an omitted one", async () => {
            expect(
                await storedKeyChain().compareDocument(
                    "tenant",
                    keyChain({ rotationPolicy: { enabled: false } }),
                ),
            ).toEqual({ unchanged: true, changes: [] });
        });
        /** Exports the stored key chain as the only resource of a bundle. */
        async function exportedKeyChain(result: any) {
            const none = { find: async () => [], findOneBy: async () => null };
            Object.assign(result.repos, {
                tenants: { findOneByOrFail: async () => ({ name: "Tenant" }) },
                clients: none,
                registrarConfigs: none,
                issuanceConfigs: none,
                credentialConfigs: none,
                presentationConfigs: none,
                attributeProviders: none,
                webhookEndpoints: none,
                trustLists: none,
                federationTrustAnchors: none,
                statusLists: none,
            });
            result.kmsTenantConfigService = { getTenantConfig: () => null };
            result.ownershipService = {
                get: async () => ({ generation: 1, ownership: "unmanaged" }),
            };

            const { documents } = await result.exportBundle("tenant");
            return documents.find(
                (document: ConfigDocument) =>
                    document.$schema === schemaUrl("KeyChain"),
            );
        }

        it("plans an exported key chain without rotation values as unchanged", async () => {
            const result = storedKeyChain() as any;
            const exported = await exportedKeyChain(result);

            expect(exported.spec.rotationPolicy).toEqual({ enabled: false });
            expect(exported.spec.type).toBe("standalone");
            expect(
                await result.compareDocument("tenant", {
                    ...exported,
                    kind: "KeyChain",
                }),
            ).toEqual({ unchanged: true, changes: [] });
        });

        it("exports the type of an internal chain and plans it as unchanged", async () => {
            const result = storedKeyChain({
                rootJwk: publicJwk,
                rootExternalKeyId: "vault-root",
                rootCertificate: "root",
                hasInternalCa: () => true,
            }) as any;
            const exported = await exportedKeyChain(result);

            expect(exported.spec).toMatchObject({
                type: "internalChain",
                keySource: { activeExternalKeyId: "vault-key" },
                crt: ["root"],
            });
            expect(
                await result.compareDocument("tenant", {
                    ...exported,
                    kind: "KeyChain",
                }),
            ).toEqual({ unchanged: true, changes: [] });
        });
        it("treats null rotation values from earlier exports like omitted ones", async () => {
            expect(
                await storedKeyChain().compareDocument(
                    "tenant",
                    keyChain({
                        rotationPolicy: {
                            enabled: false,
                            intervalDays: null,
                            certValidityDays: null,
                        },
                    }),
                ),
            ).toEqual({ unchanged: true, changes: [] });
        });
        it("treats an omitted rotation policy as disabled rotation", async () => {
            const stored = storedKeyChain();
            expect(
                await stored.compareDocument("tenant", keyChain({})),
            ).toEqual({ unchanged: true, changes: [] });
            const rotating = storedKeyChain({
                rotationEnabled: true,
                rotationIntervalDays: 30,
            });
            expect(
                await rotating.compareDocument("tenant", keyChain({})),
            ).toEqual({
                unchanged: false,
                changes: [
                    {
                        path: "/spec/rotationPolicy/enabled",
                        before: true,
                        after: false,
                    },
                    {
                        path: "/spec/rotationPolicy/intervalDays",
                        before: 30,
                    },
                ],
            });
        });
        const jwk = { ...publicJwk, d: "private" };
        // Rotation changes the plan lists for a stored internal db chain.
        const plannedRotation = async (
            row: Record<string, unknown>,
            keySource: Record<string, unknown>,
            rotationPolicy: Record<string, unknown>,
        ) =>
            (
                await storedKeyChain({
                    kmsProvider: "db",
                    externalKeyId: null,
                    rootJwk: jwk,
                    rootCertificate: "root",
                    hasInternalCa: () => true,
                    ...row,
                }).compareDocument(
                    "tenant",
                    keyChain({
                        kmsProvider: "db",
                        keySource: { type: "private-jwk", jwk, ...keySource },
                        crt: ["root"],
                        rotationPolicy,
                    }),
                )
            ).changes.filter(({ path }) =>
                path.startsWith("/spec/rotationPolicy"),
            );

        it("plans the rotation values the importer stores for a private key without active key", async () => {
            // With rotation, the importer fills in its default interval.
            expect(
                await plannedRotation(
                    {
                        rotationEnabled: true,
                        rotationIntervalDays: 90,
                        certValidityDays: 30,
                    },
                    {},
                    { enabled: true, certValidityDays: 30 },
                ),
            ).toEqual([]);
            // Without rotation, it stores no intervals.
            expect(
                await plannedRotation(
                    {},
                    {},
                    { enabled: false, intervalDays: 30, certValidityDays: 30 },
                ),
            ).toEqual([]);
        });
        it("plans the rotation values of an internal chain with private keys as given", async () => {
            const activeKey = { activeJwk: jwk };
            // No import defaults with rotation enabled.
            expect(
                await plannedRotation({ rotationEnabled: true }, activeKey, {
                    enabled: true,
                }),
            ).toEqual([]);
            // Intervals are kept without rotation.
            expect(
                await plannedRotation(
                    { rotationIntervalDays: 30, certValidityDays: 60 },
                    activeKey,
                    { enabled: false, intervalDays: 30, certValidityDays: 60 },
                ),
            ).toEqual([]);
        });
        it("reports the removal of values a key chain document leaves out", async () => {
            const stored = storedKeyChain({
                description: "Signing key",
                rotationEnabled: true,
                rotationIntervalDays: 30,
                certValidityDays: 365,
            });
            expect(
                await stored.compareDocument(
                    "tenant",
                    keyChain({
                        rotationPolicy: { enabled: true, intervalDays: null },
                    }),
                ),
            ).toEqual({
                unchanged: false,
                changes: [
                    { path: "/spec/description", before: "Signing key" },
                    {
                        path: "/spec/rotationPolicy/certValidityDays",
                        before: 365,
                    },
                    {
                        path: "/spec/rotationPolicy/intervalDays",
                        before: 30,
                    },
                ],
            });
        });
    });
    it("reports a description added to a trust list without one as new", async () => {
        const entities = [
            {
                type: "internal",
                issuerKeyChainId: "issuer",
                revocationKeyChainId: "issuer",
                info: {
                    name: "Issuer",
                    contactUri: "info@example.com",
                    website: "https://example.com/",
                },
            },
        ];
        const result = service({}) as any;
        // Use the real stored-spec mapping instead of the stub.
        delete result.currentSpec;
        result.repos = {
            trustLists: {
                findOneBy: async () => ({
                    description: null,
                    keyChainId: "signer",
                    entityConfig: entities,
                }),
            },
        };
        const document: ConfigDocument = {
            $schema: schemaUrl("TrustList"),
            kind: "TrustList",
            metadata: {},
            spec: {
                id: "list",
                description: "Signer list",
                keyChainId: "signer",
                entities,
            },
        };
        expect(await result.compareDocument("tenant", document)).toEqual({
            unchanged: false,
            changes: [{ path: "/spec/description", after: "Signer list" }],
        });
    });
    it("detects removal of fields in KMS configs that replace the entire file", async () => {
        const document: ConfigDocument = {
            $schema: schemaUrl("KmsConfig"),
            kind: "KmsConfig",
            metadata: {},
            spec: {},
        };
        expect(
            (
                await service({ vaultToken: "removed-secret" }).compareDocument(
                    "tenant",
                    document,
                )
            ).unchanged,
        ).toBe(false);
    });
    it("reports registrar fields that the replacement removes", async () => {
        const document: ConfigDocument = {
            $schema: schemaUrl("RegistrarConfig"),
            kind: "RegistrarConfig",
            metadata: {},
            spec: {
                registrarUrl: "https://registrar.example/api",
                oidcUrl: "https://auth.example/realms/registrar",
                clientId: "client",
                username: "user",
                password: "password",
            },
        };

        expect(
            await service({ ...document.spec }).compareDocument(
                "tenant",
                document,
            ),
        ).toEqual({ unchanged: true, changes: [] });
        const changed = await service({
            ...document.spec,
            clientSecret: "stored-secret",
            registrationCertificateDefaults: {
                privacy_policy: "https://rp.example/privacy",
            },
        }).compareDocument("tenant", document);
        expect(changed.unchanged).toBe(false);
        expect(changed.changes).toEqual([
            {
                path: "/spec/clientSecret",
                before: "[redacted]",
                after: undefined,
                redacted: true,
            },
            {
                path: "/spec/registrationCertificateDefaults/privacy_policy",
                before: "https://rp.example/privacy",
                after: undefined,
            },
        ]);
    });
    it("treats registrar defaults and contact set to null like omitted ones", async () => {
        const document: ConfigDocument = {
            $schema: schemaUrl("RegistrarConfig"),
            kind: "RegistrarConfig",
            metadata: {},
            spec: {
                registrarUrl: "https://registrar.example/api",
                oidcUrl: "https://auth.example/realms/registrar",
                clientId: "client",
                username: "user",
                password: "password",
                registrationCertificateDefaults: null,
                relyingPartyContact: null,
            },
        };
        const {
            registrationCertificateDefaults,
            relyingPartyContact,
            ...stored
        } = document.spec;

        expect(
            await service(stored).compareDocument("tenant", document),
        ).toEqual({ unchanged: true, changes: [] });
    });
});
