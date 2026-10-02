import { describe, expect, it, vi } from "vitest";
import {
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
    $schema: schemaUrl("Tenant"),
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
        { ...file, $schema: schemaUrl("Tenant", 2) },
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

    it("upgrades a v1 issuance configuration to v2 unchanged", () => {
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
        ]);
        expect(result.document.$schema).toBe(schemaUrl("IssuanceConfig", 2));
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

    it("refuses missing migration steps", () =>
        expect(() => migrateDocument(file, () => [], [], 2)).toThrow(
            "No unique migration",
        ));
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
