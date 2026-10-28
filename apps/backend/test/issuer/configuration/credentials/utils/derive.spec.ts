import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { assertClaimsMatchConfiguration } from "../../../../../src/issuer/configuration/credentials/domain/credential-claims-validation.js";
import {
    buildClaims,
    buildClaimsByNamespace,
    buildClaimsMetadata,
    buildDisclosureFrame,
    buildJsonSchema,
} from "../../../../../src/issuer/configuration/credentials/utils/derive.js";
import type { ClaimFieldDefinition } from "../../../../../src/issuer/configuration/credentials/utils/types.js";
import { builtInShape, changedBuiltIns } from "../../../../shared/built-ins.js";

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

describe("prototype pollution", () => {
    const unsafeKeys = [
        "__proto__",
        "constructor",
        "prototype",
        "toString",
        "hasOwnProperty",
    ];
    const derive: Record<string, (fields: ClaimFieldDefinition[]) => unknown> =
        {
            buildClaims,
            buildDisclosureFrame,
            buildClaimsMetadata,
            buildJsonSchema,
            buildClaimsByNamespace,
            assertClaimsMatchConfiguration: (fields) => {
                try {
                    assertClaimsMatchConfiguration(
                        { id: "pollution", fields },
                        {},
                    );
                } catch {
                    // Only the effect on the built-ins matters here
                }
            },
        };

    function fieldsFor(key: string): ClaimFieldDefinition[][] {
        const field = {
            type: "string",
            mandatory: true,
            disclosable: true,
            defaultValue: "polluted",
        } as const;
        return [
            [{ ...field, path: [key, "x"] }],
            [{ ...field, path: [key] }],
            [{ ...field, path: ["a", key, "x"] }],
            [{ ...field, path: [key, key, "x"] }],
            [{ ...field, path: ["constructor", "prototype", "x"] }],
            [{ ...field, path: [key, "toString"] }],
            [{ ...field, path: [key, null, "x"] }],
            [{ ...field, path: [key, 0, "x"] }],
            [{ ...field, path: ["x"], namespace: key }],
            [{ ...field, path: [key, "x"], namespace: key }],
            [
                {
                    path: [key],
                    type: "object",
                    mandatory: true,
                    children: [{ ...field, path: ["x"] }],
                },
            ],
        ];
    }

    for (const [name, fn] of Object.entries(derive)) {
        for (const key of unsafeKeys) {
            it(`${name} leaves the built-ins untouched for "${key}"`, () => {
                const before = builtInShape();
                for (const fields of fieldsFor(key)) {
                    fn(fields);
                }
                expect(changedBuiltIns(before)).toEqual([]);
                expect(
                    ({} as Record<string, unknown>).required,
                ).toBeUndefined();
            });
        }
    }

    it("keeps __proto__ segments as own keys of the derived objects", () => {
        const fields: ClaimFieldDefinition[] = [
            {
                path: ["__proto__", "x"],
                type: "string",
                mandatory: true,
                disclosable: true,
                defaultValue: "value",
            },
        ];

        const claims = buildClaims(fields);
        expect(Object.getPrototypeOf(claims)).toBe(Object.prototype);
        expect(Object.hasOwn(claims, "__proto__")).toBe(true);
        expect(JSON.parse(JSON.stringify(claims))).toEqual(
            JSON.parse('{"__proto__":{"x":"value"}}'),
        );

        const schema = buildJsonSchema(fields);
        expect(Object.hasOwn(schema.properties ?? {}, "__proto__")).toBe(true);
        expect(schema.properties?.["__proto__"]?.required).toEqual(["x"]);

        const frame = buildDisclosureFrame(fields) ?? {};
        expect(Object.hasOwn(frame, "__proto__")).toBe(true);
    });

    it("keeps a __proto__ namespace as an own key", () => {
        const byNamespace = buildClaimsByNamespace([
            {
                path: ["x"],
                namespace: "__proto__",
                type: "string",
                defaultValue: "value",
            },
        ]);

        expect(Object.hasOwn(byNamespace, "__proto__")).toBe(true);
        expect(Object.getPrototypeOf(byNamespace)).toBe(Object.prototype);
    });
});
