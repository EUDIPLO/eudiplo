import { DISPLAY_COLOR_MESSAGE } from "@eudiplo/config-format/display-entries.js";
import { BadRequestException } from "@nestjs/common";
import { describe, expect, test } from "vitest";
import { createConfigBodyPipe } from "../../../../shared/common/zod/zod-schema.util.js";
import {
    AttestationLoS,
    SchemaMetaBindingType,
    SchemaMetaConfigSchema,
    SchemaMetaFrameworkType,
    SchemaUriEntrySchema,
    TrustAuthorityEntrySchema,
} from "../dto/schema-meta-config.schema.js";
import { CredentialConfigCreateSchema } from "./credential-config.schema.js";

const credentialConfig = {
    id: "pid",
    config: {
        format: "dc+sd-jwt",
        display: [],
    },
    fields: [],
};

describe("CredentialConfigCreateSchema active credential policy", () => {
    test("requires status management when the policy is enabled", () => {
        const result = CredentialConfigCreateSchema.safeParse({
            ...credentialConfig,
            statusManagement: false,
            activeCredentials: { enabled: true },
        });

        expect(result.success).toBe(false);
        expect(result.error?.issues).toEqual([
            expect.objectContaining({
                path: ["statusManagement"],
                message:
                    "statusManagement must be enabled when activeCredentials is enabled.",
            }),
        ]);
    });

    test("accepts the single-active-credential policy", () => {
        const result = CredentialConfigCreateSchema.safeParse({
            ...credentialConfig,
            statusManagement: true,
            activeCredentials: { enabled: true, tracking: "internal" },
        });

        expect(result.success).toBe(true);
    });

    test("rejects the unsupported maxActive option", () => {
        const result = CredentialConfigCreateSchema.safeParse({
            ...credentialConfig,
            statusManagement: true,
            activeCredentials: { enabled: true, maxActive: 2 },
        });

        expect(result.success).toBe(false);
    });

    test("allows an existing policy to be cleared", () => {
        const result = CredentialConfigCreateSchema.safeParse({
            ...credentialConfig,
            activeCredentials: null,
        });

        expect(result.success).toBe(true);
    });
});

describe("CredentialConfigCreateSchema revokeWithWalletUnit", () => {
    test("requires status management and key attestations", () => {
        const result = CredentialConfigCreateSchema.safeParse({
            ...credentialConfig,
            revokeWithWalletUnit: true,
        });

        expect(result.success).toBe(false);
        expect(result.error?.issues).toEqual([
            expect.objectContaining({
                path: ["statusManagement"],
                message:
                    "statusManagement must be enabled when revokeWithWalletUnit is enabled.",
            }),
            expect.objectContaining({
                path: ["config", "keyAttestationsRequired"],
                message:
                    "config.keyAttestationsRequired must be set when revokeWithWalletUnit is enabled.",
            }),
        ]);
    });

    test("accepts it with status management and key attestations", () => {
        const result = CredentialConfigCreateSchema.safeParse({
            ...credentialConfig,
            config: { ...credentialConfig.config, keyAttestationsRequired: {} },
            statusManagement: true,
            revokeWithWalletUnit: true,
        });

        expect(result.success).toBe(true);
    });

    test("accepts it disabled without either", () => {
        expect(
            CredentialConfigCreateSchema.safeParse({
                ...credentialConfig,
                revokeWithWalletUnit: false,
            }).success,
        ).toBe(true);
    });
});

describe("CredentialConfigCreateSchema schemaMeta", () => {
    const keys = (schema: { shape: object }) =>
        Object.keys(schema.shape).sort();
    const stored = CredentialConfigCreateSchema.shape.schemaMeta
        .unwrap()
        .unwrap();

    // Publishing schema metadata with a credentialConfigId stores the publish
    // config as schemaMeta, so the stored schema must accept everything the
    // publish request accepts.
    test("has the fields of the schema metadata publish request", () => {
        expect(keys(stored)).toEqual(keys(SchemaMetaConfigSchema));
        expect(keys(stored.shape.schemaURIs.unwrap().element)).toEqual(
            keys(SchemaUriEntrySchema),
        );
        expect(keys(stored.shape.trustedAuthorities.unwrap().element)).toEqual(
            keys(TrustAuthorityEntrySchema),
        );
    });

    test.each(Object.values(SchemaMetaFrameworkType))(
        "accepts a full publish config with frameworkType %s",
        (frameworkType) => {
            const config = {
                id: "https://schemas.example/pid",
                name: "PID",
                version: "1.0.0",
                rulebookURI: "https://rules.example/pid.md",
                attestationLoS: AttestationLoS.HIGH,
                bindingType: SchemaMetaBindingType.KEY,
                schemaURIs: [
                    {
                        credentialConfigId: "pid",
                        format: "dc+sd-jwt",
                        uri: "https://schemas.example/pid.json",
                        meta: { vct: "urn:example:pid" },
                    },
                ],
                trustedAuthorities: [
                    {
                        trustListId: "trust-list",
                        frameworkType,
                        value: "https://trust.example/list",
                        verificationMethod: { kty: "EC" },
                    },
                    { verificationMethod: '{"kty":"EC"}' },
                ],
            };
            expect(SchemaMetaConfigSchema.safeParse(config).success).toBe(true);

            expect(stored.safeParse(config).error?.issues).toBeUndefined();
        },
    );

    test.each([
        ["attestationLoS", Object.values(AttestationLoS)],
        ["bindingType", Object.values(SchemaMetaBindingType)],
    ] as const)("accepts every %s of the publish request", (field, values) => {
        for (const value of values) {
            const config = {
                version: "1.0.0",
                attestationLoS: AttestationLoS.HIGH,
                bindingType: SchemaMetaBindingType.KEY,
                [field]: value,
            };
            expect(SchemaMetaConfigSchema.safeParse(config).success).toBe(true);
            expect(stored.safeParse(config).error?.issues).toBeUndefined();
        }
    });
});

describe("CredentialConfigCreateSchema claim constraints", () => {
    const withConstraints = (constraints: unknown) => ({
        ...credentialConfig,
        fields: [
            {
                path: ["nationalities"],
                type: "array",
                constraints,
                children: [
                    {
                        path: [null],
                        type: "string",
                        constraints: { pattern: "^[A-Z]{2}$" },
                    },
                ],
            },
        ],
    });

    test("accepts JSON Schema validation and annotation keywords", () => {
        const result = CredentialConfigCreateSchema.safeParse(
            withConstraints({
                minItems: 1,
                uniqueItems: true,
                description: "Nationalities",
                items: { type: "string", title: "Nationality" },
                contains: true,
                anyOf: [{ maxItems: 3 }, false],
            }),
        );

        expect(result.error?.issues).toBeUndefined();
    });

    test("accepts object keywords with subschemas", () => {
        const result = CredentialConfigCreateSchema.safeParse({
            ...credentialConfig,
            fields: [
                {
                    path: ["extras"],
                    type: "object",
                    constraints: {
                        additionalProperties: { type: "string" },
                        propertyNames: { pattern: "^[a-z]+$" },
                        properties: { note: { type: "string", maxLength: 80 } },
                    },
                },
            ],
        });

        expect(result.error?.issues).toBeUndefined();
    });

    test("refuses a formly widget, naming the keyword and path", () => {
        const result = CredentialConfigCreateSchema.safeParse(
            withConstraints({
                widget: {
                    formlyConfig: {
                        template: "<img src=x onerror=alert(1)>",
                        props: { safeHtml: true },
                    },
                },
            }),
        );

        expect(result.error?.issues).toEqual([
            expect.objectContaining({
                code: "unrecognized_keys",
                path: ["fields", 0, "constraints"],
                message:
                    "Unsupported JSON Schema keyword(s) in constraints: widget",
            }),
        ]);
    });

    test.each([
        ["in items", { items: { type: "string", widget: {} } }],
        ["in a list", { anyOf: [{ widget: {} }] }],
        ["in a map", { properties: { note: { "x-ui": {} } } }],
        ["of another kind", { format: "date" }],
    ])("refuses unknown keywords %s", (_, constraints) => {
        expect(
            CredentialConfigCreateSchema.safeParse(withConstraints(constraints))
                .success,
        ).toBe(false);
    });

    test("refuses unknown keywords in child fields", () => {
        const config = withConstraints({ minItems: 1 });
        config.fields[0].children[0].constraints = {
            pattern: "^[A-Z]{2}$",
            widget: {},
        } as never;

        expect(
            CredentialConfigCreateSchema.safeParse(config).error?.issues,
        ).toEqual([
            expect.objectContaining({
                path: ["fields", 0, "children", 0, "constraints"],
            }),
        ]);
    });

    test("refuses a subschema that is not an object or boolean", () => {
        expect(
            CredentialConfigCreateSchema.safeParse(
                withConstraints({ items: "string" }),
            ).success,
        ).toBe(false);
    });
});

describe("CredentialConfigCreateSchema claim patterns", () => {
    const withConstraints = (constraints: Record<string, unknown>) => ({
        ...credentialConfig,
        fields: [{ path: ["name"], type: "string", constraints }],
    });

    test.each([
        ["a lookahead", { pattern: "^(?=a)a+$" }],
        ["a backreference", { pattern: "^(a)\\1$" }],
        [
            "a two-digit backreference RE2 reads as octal",
            { pattern: "^(a)\\12$" },
        ],
        ["an RE2-only escape", { pattern: "^a\\z" }],
        ["an RE2 literal quote", { pattern: "\\Qa\\E" }],
        ["a long Unicode property name", { pattern: "\\p{Letter}" }],
        ["a pattern inside anyOf", { anyOf: [{ pattern: "(?=a)" }] }],
        ["an invalid pattern", { pattern: "[" }],
        [
            "a nested patternProperties key",
            {
                properties: {
                    inner: { patternProperties: { "(?!x)": {} } },
                },
            },
        ],
        ["a propertyNames pattern", { propertyNames: { pattern: "(?<=a)b" } }],
        ["a named backreference", { pattern: "^(?<a>x)\\k<a>$" }],
        ["an unknown escape", { pattern: "^\\e$" }],
        ["inline flags", { pattern: "(?i)abc" }],
        ["\\S inside a character class", { pattern: "[\\S]" }],
        [
            "a property named default",
            { properties: { default: { type: "string", pattern: "(?=x)" } } },
        ],
        ["an empty character class", { pattern: "^[]a$" }],
        ["a negated empty character class", { pattern: "^[^][a]$" }],
        ["an overlong pattern", { pattern: "a".repeat(1001) }],
        ["a pattern with a large program", { pattern: ".{1000}".repeat(20) }],
    ])("refuses %s", (_case, constraints) => {
        const result = CredentialConfigCreateSchema.safeParse(
            withConstraints(constraints),
        );

        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.message).toContain(
            "Claim patterns are matched with RE2",
        );
    });

    test.each([
        ["an RE2 pattern", { pattern: "^[A-Z]{2}\\d{3}$" }],
        [
            "a catastrophic pattern RE2 runs in linear time",
            { pattern: "^(a+)+$" },
        ],
        ["a short Unicode property name", { pattern: "^\\p{L}+$" }],
        ["a pattern key inside const", { const: { pattern: "(?=a)" } }],
    ])("accepts %s", (_case, constraints) => {
        const result = CredentialConfigCreateSchema.safeParse(
            withConstraints(constraints),
        );

        expect(result.success).toBe(true);
    });

    test.each([
        [
            "an array field's items",
            {
                path: ["values"],
                type: "array",
                constraints: { items: { pattern: "(?=a)" } },
            },
        ],
        [
            "a child field",
            {
                path: ["a"],
                type: "object",
                children: [
                    {
                        path: ["b"],
                        type: "string",
                        constraints: { pattern: "(?=x)" },
                    },
                ],
            },
        ],
    ])("refuses a pattern in %s", (_case, field) => {
        const result = CredentialConfigCreateSchema.safeParse({
            ...credentialConfig,
            fields: [field],
        });

        expect(result.success).toBe(false);
        expect(JSON.stringify(result.error?.issues)).toContain(
            "Claim patterns are matched with RE2",
        );
    });

    test.each([
        [{ pattern: "(?=a)" }, ["pattern"]],
        [
            { properties: { inner: { patternProperties: { "(?!x)": {} } } } },
            ["properties", "inner", "patternProperties", "(?!x)"],
        ],
    ])("names the pattern's path in %j", (constraints, path) => {
        const result = CredentialConfigCreateSchema.safeParse(
            withConstraints(constraints),
        );

        expect(result.error?.issues[0]?.path).toEqual([
            "fields",
            0,
            "constraints",
            ...path,
        ]);
    });
});

describe("CredentialConfigCreateSchema display entries", () => {
    const withDisplay = (display: unknown[]) =>
        CredentialConfigCreateSchema.safeParse({
            ...credentialConfig,
            config: { format: "dc+sd-jwt", display },
        });

    test("accepts entries with only name and locale and numerical colors", () => {
        const result = withDisplay([
            { name: "PID", locale: "en-US" },
            {
                name: "PID",
                locale: "de-DE",
                background_color: "rgb(18, 16, 124)",
                text_color: "#fff",
            },
        ]);

        expect(result.success).toBe(true);
    });

    test("refuses a color wallets cannot read", () => {
        const result = withDisplay([
            { name: "PID", locale: "en-US", text_color: "navy" },
        ]);

        expect(result.error?.issues).toEqual([
            expect.objectContaining({
                path: ["config", "display", 0, "text_color"],
                message: DISPLAY_COLOR_MESSAGE,
            }),
        ]);
    });

    test("refuses both on a partial update (PATCH) as well", async () => {
        const pipe = createConfigBodyPipe(CredentialConfigCreateSchema, {
            readOnly: [],
            partial: true,
        });
        const transform = (display: unknown[]) =>
            pipe.transform(
                { config: { format: "dc+sd-jwt", display } },
                { type: "body" },
            );

        await expect(
            transform([{ name: "PID", locale: "en-US", text_color: "navy" }]),
        ).rejects.toThrow(BadRequestException);
        await expect(
            transform([
                { name: "PID", locale: "en-US" },
                { name: "PID", locale: "en-us" },
            ]),
        ).rejects.toThrow(BadRequestException);
        await expect(
            transform([{ name: "PID", locale: "en-US", text_color: "#fff" }]),
        ).resolves.toEqual({
            config: {
                format: "dc+sd-jwt",
                display: [{ name: "PID", locale: "en-US", text_color: "#fff" }],
            },
        });
    });

    test("refuses a second entry for the same locale", () => {
        const result = withDisplay([
            { name: "PID", locale: "en-US" },
            { name: "PID (copy)", locale: "EN-us" },
        ]);

        expect(result.error?.issues).toEqual([
            expect.objectContaining({
                path: ["config", "display", 1, "locale"],
                message:
                    "Locale EN-us is already used by display entry 1. OID4VCI allows one display entry per language.",
            }),
        ]);
    });
});
