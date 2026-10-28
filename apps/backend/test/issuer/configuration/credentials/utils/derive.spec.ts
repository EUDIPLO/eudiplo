import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
    buildClaimsByNamespace,
    buildJsonSchema,
} from "../../../../../src/issuer/configuration/credentials/utils/derive.js";
import type { ClaimFieldDefinition } from "../../../../../src/issuer/configuration/credentials/utils/types.js";

function compile(fields: ClaimFieldDefinition[]) {
    const ajv = new Ajv2020({
        allErrors: true,
        strict: true,
        useDefaults: true,
        validateSchema: false,
    });
    return ajv.compile(buildJsonSchema(fields) as any);
}

describe("buildClaimsByNamespace", () => {
    it("infers the namespace from the first path segment when namespace is omitted", () => {
        const claimsByNamespace = buildClaimsByNamespace([
            {
                path: ["eu.europa.ec.eudi.pid.1", "given_name"],
                type: "string",
                defaultValue: "ERIKA",
            },
            {
                path: ["eu.europa.ec.eudi.pid.1", "age_over_18"],
                type: "boolean",
                defaultValue: true,
            },
        ] as any);

        expect(claimsByNamespace).toEqual({
            "eu.europa.ec.eudi.pid.1": {
                given_name: "ERIKA",
                age_over_18: true,
            },
        });
    });

    it("still uses an explicit namespace when provided", () => {
        const claimsByNamespace = buildClaimsByNamespace([
            {
                path: ["given_name"],
                type: "string",
                defaultValue: "ERIKA",
                namespace: "eu.europa.ec.eudi.pid.1",
            },
        ] as any);

        expect(claimsByNamespace).toEqual({
            "eu.europa.ec.eudi.pid.1": {
                given_name: "ERIKA",
            },
        });
    });
});

describe("buildJsonSchema", () => {
    it("produces AJV-valid schemas for array claims like nationalities", () => {
        const validate = compile([
            { path: ["nationalities", 0], type: "string", defaultValue: "DE" },
            {
                path: ["nationalities"],
                type: "array",
                defaultValue: ["DE"],
                constraints: {
                    items: { type: "string", title: "Nationality" },
                },
            },
        ]);

        expect(validate({ nationalities: ["DE"] })).toBe(true);
    });

    it("keeps object claim branches typed as objects when they hold nested properties", () => {
        const schema = buildJsonSchema([
            {
                path: ["place_of_birth", "locality"],
                type: "string",
                defaultValue: "BERLIN",
                mandatory: true,
            },
            {
                path: ["place_of_birth"],
                type: "object",
                defaultValue: { locality: "BERLIN" },
                mandatory: true,
            },
        ]);

        expect(schema.properties?.place_of_birth).toMatchObject({
            type: "object",
            properties: { locality: { type: "string" } },
        });
    });

    it("accepts valid claims and rejects missing required claims and wrong types", () => {
        const validate = compile([
            { path: ["given_name"], type: "string", mandatory: true },
            { path: ["age"], type: "integer" },
        ]);

        expect(validate({ given_name: "ERIKA", age: 40 })).toBe(true);
        expect(validate({ age: 40 })).toBe(false);
        expect(validate({ given_name: "ERIKA", age: "40" })).toBe(false);
    });

    it("rejects unexpected top-level claims", () => {
        const validate = compile([{ path: ["given_name"], type: "string" }]);

        expect(validate({ given_name: "ERIKA", unknown: "x" })).toBe(false);
        expect(validate.errors?.[0]).toMatchObject({
            keyword: "additionalProperties",
            params: { additionalProperty: "unknown" },
        });
    });

    it("rejects unexpected properties in objects defined with children", () => {
        const validate = compile([
            {
                path: ["address"],
                type: "object",
                children: [
                    { path: ["street"], type: "string", mandatory: true },
                    { path: ["locality"], type: "string" },
                ],
            },
        ]);

        expect(validate({ address: { street: "Main St" } })).toBe(true);
        expect(validate({ address: { street: "Main St", floor: 3 } })).toBe(
            false,
        );
        expect(validate({ address: {} })).toBe(false);
        expect(validate({ address: { street: 1 } })).toBe(false);
    });

    it("allows free-form objects that opt in via constraints, in any field order", () => {
        const freeFormParent: ClaimFieldDefinition = {
            path: ["metadata"],
            type: "object",
            constraints: { additionalProperties: true },
        };
        const knownChild: ClaimFieldDefinition = {
            path: ["metadata", "source"],
            type: "string",
        };

        for (const fields of [
            [freeFormParent, knownChild],
            [knownChild, freeFormParent],
        ]) {
            const validate = compile(fields);
            expect(validate({ metadata: { source: "a", dynamic: 1 } })).toBe(
                true,
            );
            expect(validate({ metadata: { source: 1 } })).toBe(false);
        }
    });

    it("drops constraint keywords outside the JSON Schema allow-list", () => {
        // Stored before the write check: strict AJV refused the unknown keywords
        const fields: ClaimFieldDefinition[] = [
            {
                path: ["birth_date"],
                type: "string",
                constraints: {
                    pattern: String.raw`^\d{4}-\d{2}-\d{2}$`,
                    widget: {
                        formlyConfig: {
                            template: "<img src=x onerror=alert(1)>",
                            props: { safeHtml: true },
                        },
                    },
                    "x-ui": true,
                    format: "date",
                },
            },
            {
                path: ["nationalities"],
                type: "array",
                constraints: {
                    items: { type: "string", widget: {} },
                    anyOf: [{ minItems: 1, widget: {} }, "not a schema"],
                },
            },
        ];

        expect(buildJsonSchema(fields).properties).toEqual({
            birth_date: {
                type: "string",
                pattern: String.raw`^\d{4}-\d{2}-\d{2}$`,
            },
            nationalities: {
                type: "array",
                items: { type: "string" },
                anyOf: [{ minItems: 1 }],
            },
        });

        const validate = compile(fields);
        expect(
            validate({ birth_date: "1964-08-12", nationalities: ["DE"] }),
        ).toBe(true);
        expect(validate({ birth_date: "12.08.1964", nationalities: [] })).toBe(
            false,
        );
    });

    it("treats object claims without declared children as free-form", () => {
        const validate = compile([{ path: ["extra"], type: "object" }]);

        expect(validate({ extra: { anything: [1, 2] } })).toBe(true);
    });

    it("rejects unexpected properties in array item objects", () => {
        const validate = compile([
            { path: ["nationalities", null, "country"], type: "string" },
        ]);

        expect(validate({ nationalities: [{ country: "DE" }] })).toBe(true);
        expect(
            validate({ nationalities: [{ country: "DE", extra: true }] }),
        ).toBe(false);
    });

    it("treats children of an array field as properties of its items", () => {
        const validate = compile([
            {
                path: ["driving_privileges"],
                type: "array",
                mandatory: true,
                children: [
                    {
                        path: ["vehicle_category_code"],
                        type: "string",
                        mandatory: true,
                    },
                    {
                        path: ["codes"],
                        type: "array",
                        children: [
                            { path: ["code"], type: "string", mandatory: true },
                        ],
                    },
                ],
            },
        ]);

        expect(
            validate({
                driving_privileges: [
                    { vehicle_category_code: "B", codes: [{ code: "B96" }] },
                ],
            }),
        ).toBe(true);
        expect(validate({ driving_privileges: [{ codes: [] }] })).toBe(false);
        expect(
            validate({
                driving_privileges: [
                    { vehicle_category_code: "B", codes: [{}] },
                ],
            }),
        ).toBe(false);
    });

    it("keeps explicit item steps in children of an array field", () => {
        const validate = compile([
            {
                path: ["nationalities"],
                type: "array",
                children: [{ path: [null, "country"], type: "string" }],
            },
        ]);

        expect(validate({ nationalities: [{ country: "DE" }] })).toBe(true);
    });
});
