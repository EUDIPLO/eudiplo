import { describe, expect, it, vi } from "vitest";
import {
    bareFileVersion,
    CONFIG_FORMATS,
    CONFIG_RESOURCE_KINDS,
    CONFIG_SINGLETON_IDS,
    type ConfigMigration,
    isConfigDocument,
    migrateDocument,
    normalizeDocument,
    resolveConfigIdentity,
    resourceId,
    schemaUrl,
    serializeDocument,
} from "./config-format.js";
import { validateConfigDocument } from "./config-validator.js";

const file = {
    $schema: schemaUrl("Tenant", 1),
    metadata: { generation: 3 },
    spec: { name: "Example" },
};

describe("portable schema identity and migrations", () => {
    it.each(CONFIG_RESOURCE_KINDS)(
        "resolves schema identity for %s",
        (kind) => {
            expect(resolveConfigIdentity({ $schema: schemaUrl(kind) })).toEqual(
                {
                    kind,
                    version: CONFIG_FORMATS[kind].version,
                },
            );
            const document = normalizeDocument({
                $schema: schemaUrl(kind),
                spec: CONFIG_SINGLETON_IDS[kind]
                    ? {}
                    : { [kind === "Client" ? "clientId" : "id"]: "test" },
            });
            expect(resourceId(document)).toBe(
                CONFIG_SINGLETON_IDS[kind] ?? "test",
            );
            expect(() => validateConfigDocument(document)).not.toThrow();
        },
    );

    it("serializes canonical files without legacy identifiers", () => {
        expect(serializeDocument(file)).toEqual(file);
        expect(migrateDocument(file, validateConfigDocument).issues).toEqual(
            [],
        );
    });

    it.each([
        { ...file, apiVersion: "eudiplo.dev/tenant/v1" },
        {
            ...file,
            $schema:
                "https://attacker.example/schemas/v2/TenantConfigFile.schema.json",
        },
        { ...file, $schema: `${schemaUrl("Tenant")}?version=1` },
        { ...file, $schema: schemaUrl("Tenant", 99) },
        { ...file, $schema: schemaUrl("Tenant", 4) },
        { ...file, metadata: { generation: 0 } },
        { ...file, metadata: { id: "tenant" } },
        { ...file, spec: [] },
        { ...file, unexpected: true },
    ])("rejects non-canonical envelopes", (input) =>
        expect(() => normalizeDocument(input)).toThrow(),
    );

    it("recognizes only schema-marked documents", () => {
        expect(isConfigDocument({ $schema: null })).toBe(true);
        expect(isConfigDocument({ apiVersion: "eudiplo.dev/tenant/v1" })).toBe(
            false,
        );
        expect(isConfigDocument({ name: "Legacy" })).toBe(false);
    });

    const step: ConfigMigration = {
        id: "rename-name",
        kind: "Tenant",
        from: 1,
        to: 2,
        migrate: (spec, metadata) => ({
            spec: { displayName: spec.name },
            metadata: { generation: metadata.generation },
        }),
    };

    it("validates source and target before advancing the version", () => {
        const validate = vi.fn(() => []);
        const result = migrateDocument(file, validate, [step], 2);
        expect(validate).toHaveBeenCalledTimes(2);
        expect(result.document.$schema).toBe(schemaUrl("Tenant", 2));
        expect(result.document.spec).toEqual({ displayName: "Example" });
        expect(result.migrations).toEqual(["rename-name"]);
    });

    it("upgrades a v1 issuance configuration to v5 unchanged", () => {
        const v1 = {
            $schema: schemaUrl("IssuanceConfig", 1),
            metadata: { generation: 2 },
            spec: {
                authorizationServers: [{ id: "issuer", type: "built-in" }],
                txCodeMaxAttempts: 3,
            },
        };
        const result = migrateDocument(v1, validateConfigDocument);
        expect(result.issues).toEqual([]);
        expect(result.migrations).toEqual([
            "issuance-config-v2-offer-lifetime",
            "issuance-config-v3-trust-list-verifier-pem",
            "issuance-config-v4-wallet-attestation-status-check-mode",
            "issuance-config-v5-federation-entity",
        ]);
        expect(result.document.$schema).toBe(schemaUrl("IssuanceConfig", 5));
        expect(result.document.spec).toEqual(v1.spec);
        expect(result.document.metadata).toEqual({ generation: 2 });
        // Repeating the upgrade on the result is a no-op.
        expect(
            migrateDocument(result.document, validateConfigDocument).migrations,
        ).toEqual([]);
    });

    it("accepts the v2-only offer lifetime only from v2 on", () => {
        const spec = {
            authorizationServers: [{ id: "issuer", type: "built-in" }],
            offerLifetimeSeconds: 600,
        };
        expect(
            validateConfigDocument(
                normalizeDocument({
                    $schema: schemaUrl("IssuanceConfig", 2),
                    spec,
                }),
            ),
        ).toEqual([]);
        expect(
            validateConfigDocument(
                normalizeDocument({
                    $schema: schemaUrl("IssuanceConfig", 1),
                    spec,
                }),
            ).map((issue) => issue.message),
        ).toContain("Unknown property: offerLifetimeSeconds");
    });

    it("accepts a PEM trust-list verifier only from v3 on", () => {
        const spec = {
            authorizationServers: [{ id: "issuer", type: "built-in" }],
            walletProviderTrustLists: [
                {
                    url: "https://trust.example/wallet-providers",
                    verifierKeyPem:
                        "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----",
                },
            ],
        };
        expect(
            validateConfigDocument(
                normalizeDocument({
                    $schema: schemaUrl("IssuanceConfig", 3),
                    spec,
                }),
            ),
        ).toEqual([]);
        expect(
            validateConfigDocument(
                normalizeDocument({
                    $schema: schemaUrl("IssuanceConfig", 2),
                    spec,
                }),
            ).map((issue) => issue.message),
        ).toContain("Unknown property: verifierKeyPem");
    });

    it("upgrades a v1 key chain to v3 unchanged", () => {
        const v1 = {
            $schema: schemaUrl("KeyChain", 1),
            metadata: { generation: 2 },
            spec: {
                id: "issuer",
                usageType: "attestation",
                keySource: { type: "regenerate" },
            },
        };
        const result = migrateDocument(v1, validateConfigDocument);
        expect(result.issues).toEqual([]);
        expect(result.migrations).toEqual([
            "key-chain-v2-type",
            "key-chain-v3-federation-usage",
        ]);
        expect(result.document.$schema).toBe(schemaUrl("KeyChain", 3));
        expect(result.document.spec).toEqual(v1.spec);
        expect(result.document.metadata).toEqual({ generation: 2 });
        expect(
            migrateDocument(result.document, validateConfigDocument).migrations,
        ).toEqual([]);
    });

    it("accepts the federation usage type only from v3 on", () => {
        const spec = {
            id: "federation",
            usageType: "federation",
            keySource: { type: "regenerate" },
        };
        const issues = (version: number) =>
            validateConfigDocument(
                normalizeDocument({
                    $schema: schemaUrl("KeyChain", version),
                    metadata: { generation: 1 },
                    spec,
                }),
            );
        expect(issues(2).length).toBeGreaterThan(0);
        expect(issues(3)).toEqual([]);
        expect(bareFileVersion("KeyChain", spec)).toBe(3);
    });

    it("accepts the federation entity fields only from IssuanceConfig v5 on", () => {
        const spec = {
            authorizationServers: [{ id: "issuer", type: "built-in" }],
            federation: {
                entityId: "https://issuer.example.org",
                trustAnchors: [
                    {
                        entityId: "https://ta.example.org",
                        entityConfigurationUri:
                            "https://ta.example.org/.well-known/openid-federation",
                    },
                ],
                entityTypes: ["openid_credential_verifier"],
            },
        };
        const issues = (version: number) =>
            validateConfigDocument(
                normalizeDocument({
                    $schema: schemaUrl("IssuanceConfig", version),
                    metadata: { generation: 1 },
                    spec,
                }),
            );
        expect(issues(4).map((issue) => issue.message)).toContain(
            "Unknown property: entityTypes",
        );
        expect(issues(5)).toEqual([]);
    });

    it("accepts a key chain type only from v2 on", () => {
        const document = (version: number, type: string) =>
            normalizeDocument({
                $schema: schemaUrl("KeyChain", version),
                metadata: { generation: 1 },
                spec: {
                    id: "issuer",
                    usageType: "attestation",
                    type,
                    keySource: { type: "regenerate" },
                },
            });
        expect(validateConfigDocument(document(2, "internalChain"))).toEqual(
            [],
        );
        expect(
            validateConfigDocument(document(1, "internalChain")).map(
                (issue) => issue.message,
            ),
        ).toContain("Unknown property: type");
        expect(validateConfigDocument(document(2, "external"))).not.toEqual(
            [],
        );
    });

    it("keeps every version and the bare form in the editor schema of a key chain", async () => {
        const { readFile } = await import("node:fs/promises");
        const { Ajv2020 } = await import("ajv/dist/2020.js");
        // The unversioned file that editors associate with key-chains/*.json.
        const validate = new Ajv2020({
            strict: false,
            validateFormats: false,
        }).compile(
            JSON.parse(
                await readFile(
                    new URL(
                        "../../../schemas/KeyChainConfigFile.schema.json",
                        import.meta.url,
                    ),
                    "utf8",
                ),
            ),
        );
        const jwk = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" };
        const spec = {
            id: "issuer",
            usageType: "attestation",
            keySource: { type: "private-jwk", jwk },
        };
        const envelope = (version: number, type?: string) => ({
            $schema: schemaUrl("KeyChain", version),
            metadata: { generation: 1 },
            spec: { ...spec, ...(type ? { type } : {}) },
        });
        expect(validate(envelope(1))).toBe(true);
        expect(validate(envelope(2, "internalChain"))).toBe(true);
        expect(validate(envelope(1, "internalChain"))).toBe(false);
        expect(
            validate({
                id: "issuer",
                usageType: "attestation",
                type: "internalChain",
                key: jwk,
            }),
        ).toBe(true);
    });

    it.each([
        ["KeyChain", { type: "standalone" }, 2],
        ["KeyChain", {}, 1],
        ["Client", { type: "standalone" }, 1],
        [
            "KmsConfig",
            { providers: [{ id: "db", type: "db", algorithms: ["ES384"] }] },
            2,
        ],
        [
            "KmsConfig",
            {
                providers: [
                    { id: "db", type: "db" },
                    { id: "hsm", type: "pkcs11", defaultAlgorithm: "ES384" },
                ],
            },
            2,
        ],
        ["KmsConfig", { providers: [{ id: "db", type: "db" }] }, 1],
        [
            "RegistrarConfig",
            { relyingPartyContact: { email: "support@verifier.example" } },
            2,
        ],
        ["RegistrarConfig", { registrarUrl: "https://registrar.example" }, 1],
        ["Tenant", { name: "Demo", defaultKeyChains: { access: "access" } }, 3],
        ["Tenant", { name: "Demo", defaultAccessKeyChainId: "access" }, 2],
        ["Tenant", { name: "Demo" }, 1],
    ] as const)("reads a bare %s file %o as v%i", (kind, spec, version) => {
        expect(bareFileVersion(kind, spec)).toBe(version);
    });

    it("upgrades a v1 credential configuration to v2 unchanged", () => {
        const v1 = {
            $schema: schemaUrl("CredentialConfig", 1),
            metadata: { generation: 2 },
            spec: {
                id: "pid",
                config: { format: "dc+sd-jwt", display: [] },
                fields: [],
            },
        };
        const result = migrateDocument(v1, validateConfigDocument);
        expect(result.issues).toEqual([]);
        expect(result.migrations).toEqual([
            "credential-config-v2-x509-trusted-authority",
        ]);
        expect(result.document.$schema).toBe(schemaUrl("CredentialConfig", 2));
        expect(result.document.spec).toEqual(v1.spec);
        expect(result.document.metadata).toEqual({ generation: 2 });
        // Repeating the upgrade on the result is a no-op.
        expect(
            migrateDocument(result.document, validateConfigDocument).migrations,
        ).toEqual([]);
    });

    it("upgrades a v1 client to v2 unchanged", () => {
        const v1 = {
            $schema: schemaUrl("Client", 1),
            metadata: { generation: 3 },
            spec: { clientId: "shop-backend", roles: ["issuance:offer"] },
        };
        const result = migrateDocument(v1, validateConfigDocument);
        expect(result.issues).toEqual([]);
        expect(result.migrations).toEqual(["client-v2-read-and-status-roles"]);
        expect(result.document.$schema).toBe(schemaUrl("Client", 2));
        expect(result.document.spec).toEqual(v1.spec);
        expect(result.document.metadata).toEqual({ generation: 3 });
        expect(
            migrateDocument(result.document, validateConfigDocument).migrations,
        ).toEqual([]);
    });

    it("upgrades a v1 KMS configuration to v2 unchanged", () => {
        const v1 = {
            $schema: schemaUrl("KmsConfig", 1),
            metadata: { generation: 1 },
            spec: { providers: [{ id: "db", type: "db" }] },
        };
        const result = migrateDocument(v1, validateConfigDocument);
        expect(result.issues).toEqual([]);
        expect(result.migrations).toEqual(["kms-config-v2-algorithms"]);
        expect(result.document.$schema).toBe(schemaUrl("KmsConfig", 2));
        expect(result.document.spec).toEqual(v1.spec);
        expect(
            migrateDocument(result.document, validateConfigDocument).migrations,
        ).toEqual([]);
    });

    it("upgrades a v1 registrar configuration to v2 unchanged", () => {
        const v1 = {
            $schema: schemaUrl("RegistrarConfig", 1),
            metadata: { generation: 1 },
            spec: {
                registrarUrl: "https://registrar.example/api",
                oidcUrl: "https://auth.example/realms/registrar",
                clientId: "registrar-client",
                username: "verifier",
                password: "secret",
            },
        };
        const result = migrateDocument(v1, validateConfigDocument);
        expect(result.issues).toEqual([]);
        expect(result.migrations).toEqual([
            "registrar-config-v2-relying-party-contact",
        ]);
        expect(result.document.$schema).toBe(schemaUrl("RegistrarConfig", 2));
        expect(result.document.spec).toEqual(v1.spec);
        expect(
            migrateDocument(result.document, validateConfigDocument).migrations,
        ).toEqual([]);
    });

    it("upgrades a v1 tenant to v3 unchanged", () => {
        const v1 = {
            $schema: schemaUrl("Tenant", 1),
            metadata: { generation: 4 },
            spec: { name: "Demo Tenant", description: "Demo" },
        };
        const result = migrateDocument(v1, validateConfigDocument);
        expect(result.issues).toEqual([]);
        expect(result.migrations).toEqual([
            "tenant-v2-default-access-key-chain",
            "tenant-v3-default-key-chains",
        ]);
        expect(result.document.$schema).toBe(schemaUrl("Tenant", 3));
        expect(result.document.spec).toEqual(v1.spec);
        expect(result.document.metadata).toEqual({ generation: 4 });
        expect(
            migrateDocument(result.document, validateConfigDocument).migrations,
        ).toEqual([]);
    });

    it("moves the v2 default access key chain into defaultKeyChains", () => {
        const v2 = {
            $schema: schemaUrl("Tenant", 2),
            metadata: { generation: 2 },
            spec: { name: "Demo Tenant", defaultAccessKeyChainId: "access" },
        };
        const result = migrateDocument(v2, validateConfigDocument);
        expect(result.issues).toEqual([]);
        expect(result.migrations).toEqual(["tenant-v3-default-key-chains"]);
        expect(result.document.$schema).toBe(schemaUrl("Tenant", 3));
        expect(result.document.spec).toEqual({
            name: "Demo Tenant",
            defaultKeyChains: { access: "access" },
        });
        expect(
            migrateDocument(result.document, validateConfigDocument).migrations,
        ).toEqual([]);
    });

    it("accepts defaultKeyChains only from tenant v3 on", () => {
        const spec = {
            name: "Demo Tenant",
            defaultKeyChains: { access: "access" },
        };
        expect(
            validateConfigDocument(
                normalizeDocument({
                    $schema: schemaUrl("Tenant", 3),
                    metadata: { generation: 1 },
                    spec,
                }),
            ),
        ).toEqual([]);
        expect(
            validateConfigDocument(
                normalizeDocument({
                    $schema: schemaUrl("Tenant", 2),
                    metadata: { generation: 1 },
                    spec,
                }),
            ).length,
        ).toBeGreaterThan(0);
    });

    it("accepts a default access key chain only from tenant v2 on", () => {
        const spec = { name: "Demo Tenant", defaultAccessKeyChainId: "access" };
        expect(
            validateConfigDocument(
                normalizeDocument({
                    $schema: schemaUrl("Tenant", 2),
                    metadata: { generation: 1 },
                    spec,
                }),
            ),
        ).toEqual([]);
        expect(
            validateConfigDocument(
                normalizeDocument({
                    $schema: schemaUrl("Tenant", 1),
                    metadata: { generation: 1 },
                    spec,
                }),
            ).length,
        ).toBeGreaterThan(0);
    });

    it("accepts a relying party contact only from registrar configuration v2 on", () => {
        const spec = {
            registrarUrl: "https://registrar.example/api",
            oidcUrl: "https://auth.example/realms/registrar",
            clientId: "registrar-client",
            username: "verifier",
            password: "secret",
            relyingPartyContact: { email: "support@verifier.example" },
        };
        expect(
            validateConfigDocument(
                normalizeDocument({
                    $schema: schemaUrl("RegistrarConfig", 2),
                    spec,
                }),
            ),
        ).toEqual([]);
        expect(
            validateConfigDocument(
                normalizeDocument({
                    $schema: schemaUrl("RegistrarConfig", 1),
                    spec,
                }),
            ).length,
        ).toBeGreaterThan(0);
    });

    it("accepts provider algorithms only from KMS configuration v2 on", () => {
        const spec = {
            providers: [
                {
                    id: "db",
                    type: "db",
                    algorithms: ["ES256", "ES384"],
                    defaultAlgorithm: "ES384",
                },
            ],
        };
        expect(
            validateConfigDocument(
                normalizeDocument({ $schema: schemaUrl("KmsConfig", 2), spec }),
            ),
        ).toEqual([]);
        expect(
            validateConfigDocument(
                normalizeDocument({ $schema: schemaUrl("KmsConfig", 1), spec }),
            ).length,
        ).toBeGreaterThan(0);
    });

    it.each(["audit:read", "sessions:read", "credentials:status", "keys:manage"])(
        "accepts the client role %s only from v2 on",
        (role) => {
            const spec = { clientId: "support", roles: [role] };
            expect(
                validateConfigDocument(
                    normalizeDocument({ $schema: schemaUrl("Client", 2), spec }),
                ),
            ).toEqual([]);
            expect(
                validateConfigDocument(
                    normalizeDocument({ $schema: schemaUrl("Client", 1), spec }),
                ).map((issue) => issue.path),
            ).toContain("/spec/roles/0");
        },
    );

    it("accepts an x509 schema metadata trusted authority only from v2 on", () => {
        const spec = {
            id: "pid",
            config: { format: "dc+sd-jwt", display: [] },
            fields: [],
            schemaMeta: {
                id: "https://schemas.example/pid",
                version: "1.0.0",
                attestationLoS: "iso_18045_high",
                bindingType: "key",
                trustedAuthorities: [
                    {
                        frameworkType: "x509",
                        value: "cm9vdCBjZXJ0aWZpY2F0ZQ==",
                    },
                ],
            },
        };
        expect(
            validateConfigDocument(
                normalizeDocument({
                    $schema: schemaUrl("CredentialConfig", 2),
                    spec,
                }),
            ),
        ).toEqual([]);
        expect(
            validateConfigDocument(
                normalizeDocument({
                    $schema: schemaUrl("CredentialConfig", 1),
                    spec,
                }),
            ).map((issue) => issue.path),
        ).toContain("/spec/schemaMeta/trustedAuthorities/0/frameworkType");
    });

    it("accepts a wallet attestation status check mode only from v4 on", () => {
        const spec = {
            walletAttestationStatusCheckMode: "strict",
            authorizationServers: [
                {
                    id: "issuer",
                    type: "built-in",
                    walletAttestationStatusCheckMode: "disabled",
                },
            ],
        };
        expect(
            validateConfigDocument(
                normalizeDocument({
                    $schema: schemaUrl("IssuanceConfig", 4),
                    spec,
                }),
            ),
        ).toEqual([]);
        expect(
            validateConfigDocument(
                normalizeDocument({
                    $schema: schemaUrl("IssuanceConfig", 3),
                    spec,
                }),
            ).map((issue) => issue.message),
        ).toContain("Unknown property: walletAttestationStatusCheckMode");
    });

    it("refuses missing migration steps", () =>
        expect(() => migrateDocument(file, () => [], [], 2)).toThrow(
            "No unique migration",
        ));
});

describe("IssuanceConfig v4 to v5", () => {
    const v4 = (entityId?: string) => ({
        $schema: schemaUrl("IssuanceConfig", 4),
        spec: {
            authorizationServers: [{ type: "built-in", id: "issuer" }],
            federation: {
                ...(entityId === undefined ? {} : { entityId }),
                trustAnchors: [
                    {
                        entityId: "https://ta.example.org",
                        entityConfigurationUri:
                            "https://ta.example.org/.well-known/openid-federation",
                    },
                ],
            },
        },
    });

    it.each([
        undefined,
        "https://issuer.example.org/issuers/tenant",
        "http://localhost:3000/issuers/root",
    ])("upgrades the entity id %s without an issue", (entityId) => {
        const result = migrateDocument(v4(entityId), validateConfigDocument);

        expect(result.migrations).toEqual([
            "issuance-config-v5-federation-entity",
        ]);
        expect(result.issues).toEqual([]);
        expect(result.document.spec).toEqual(v4(entityId).spec);
    });

    it.each([
        "issuer",
        "https://issuer.example.org/?tenant=a",
        "https://issuer.example.org#entity",
    ])("asks for a new entity id instead of %s and keeps the value", (entityId) => {
        const result = migrateDocument(v4(entityId), () => []);

        expect(result.issues).toEqual([
            expect.objectContaining({
                severity: "required-input",
                code: "FEDERATION_ENTITY_ID_INVALID",
                path: "/spec/federation/entityId",
            }),
        ]);
        expect(
            (result.document.spec.federation as { entityId: string }).entityId,
        ).toBe(entityId);
    });
});

describe("PresentationConfig v1 to v2", () => {
    const dcql_query = {
        credentials: [
            {
                id: "pid",
                format: "dc+sd-jwt",
                meta: { vct_values: ["urn:eudi:pid:de:1"] },
            },
        ],
    };
    const privacy = {
        privacy_policy: "https://verifier.example/privacy",
        support_uri: "https://verifier.example/support",
    };
    const spec = {
        id: "pid",
        dcql_query,
        registration_cert: {
            body: {
                ...privacy,
                provided_attestations: [{ vct: "urn:eudi:pid:de:1" }],
            },
        },
    };
    const v1 = { $schema: schemaUrl("PresentationConfig", 1), spec };

    it("drops the unused provided_attestations with a warning", () => {
        const result = migrateDocument(v1, validateConfigDocument);

        expect(result.document.$schema).toBe(schemaUrl("PresentationConfig"));
        expect(result.migrations).toEqual([
            "presentation-config-v2-provides-attestations",
            "presentation-config-v3-typed-claim-values",
        ]);
        expect(result.document.spec.registration_cert).toEqual({
            body: privacy,
        });
        expect(result.issues).toEqual([
            expect.objectContaining({
                severity: "warning",
                code: "PROVIDED_ATTESTATIONS_REMOVED",
                path: "/spec/registration_cert/body/provided_attestations",
            }),
        ]);
    });

    it("upgrades documents without the field unchanged and only once", () => {
        const plain = migrateDocument(
            {
                $schema: schemaUrl("PresentationConfig", 1),
                spec: { id: "pid", dcql_query },
            },
            validateConfigDocument,
        );
        expect(plain.issues).toEqual([]);
        expect(plain.document.$schema).toBe(schemaUrl("PresentationConfig"));
        expect(plain.document.spec).toEqual({ id: "pid", dcql_query });

        const again = migrateDocument(
            migrateDocument(v1, validateConfigDocument).document,
            validateConfigDocument,
        );
        expect(again.migrations).toEqual([]);
        expect(again.issues).toEqual([]);
    });

    it("validates provides_attestations only from v2 on", () => {
        const withField = (version: number) =>
            normalizeDocument({
                $schema: schemaUrl("PresentationConfig", version),
                spec: {
                    ...spec,
                    registration_cert: {
                        body: {
                            ...privacy,
                            provides_attestations: ["urn:eudi:pid:de:1"],
                        },
                    },
                },
            });
        const unknownProperty = (name: string) =>
            expect.arrayContaining([
                expect.objectContaining({
                    message: `Unknown property: ${name}`,
                }),
            ]);

        expect(validateConfigDocument(withField(2))).toEqual([]);
        expect(validateConfigDocument(withField(1))).toEqual(
            unknownProperty("provides_attestations"),
        );
        expect(
            validateConfigDocument(
                normalizeDocument({
                    ...v1,
                    $schema: schemaUrl("PresentationConfig", 2),
                }),
            ),
        ).toEqual(unknownProperty("provided_attestations"));
    });
});

describe("PresentationConfig v2 to v3", () => {
    const withValues = (version: number, values: unknown[]) => ({
        $schema: schemaUrl("PresentationConfig", version),
        spec: {
            id: "age",
            dcql_query: {
                credentials: [
                    {
                        id: "pid",
                        format: "dc+sd-jwt",
                        meta: { vct_values: ["urn:eudi:pid:de:1"] },
                        claims: [{ path: ["age_equal_or_over", "18"], values }],
                    },
                ],
            },
        },
    });

    it("upgrades string claim values unchanged and only once", () => {
        const v2 = withValues(2, ["gold", "platinum"]);
        const result = migrateDocument(v2, validateConfigDocument);

        expect(result.issues).toEqual([]);
        expect(result.migrations).toEqual([
            "presentation-config-v3-typed-claim-values",
        ]);
        expect(result.document.$schema).toBe(
            schemaUrl("PresentationConfig", 3),
        );
        expect(result.document.spec).toEqual(v2.spec);
        expect(
            migrateDocument(result.document, validateConfigDocument).migrations,
        ).toEqual([]);
    });

    it("accepts integer and boolean claim values only from v3 on", () => {
        const typed = [true, 18, "18"];
        expect(
            validateConfigDocument(normalizeDocument(withValues(3, typed))),
        ).toEqual([]);
        expect(
            validateConfigDocument(normalizeDocument(withValues(2, typed))),
        ).not.toEqual([]);
    });

    it("stops the upgrade on empty claim values", () => {
        const result = migrateDocument(
            withValues(2, []),
            validateConfigDocument,
        );

        expect(result.migrations).toEqual([]);
        expect(result.document.$schema).toBe(
            schemaUrl("PresentationConfig", 2),
        );
        expect(result.issues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    severity: "error",
                    path: "/spec/dcql_query/credentials/0/claims/0/values",
                    message: "must NOT have fewer than 1 items",
                }),
            ]),
        );
    });
});
