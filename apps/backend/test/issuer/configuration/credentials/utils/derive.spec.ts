import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { assertClaimsMatchConfiguration } from "../../../../../src/issuer/configuration/credentials/domain/credential-claims-validation.js";
import {
    buildClaims,
    buildClaimsByNamespace,
    buildClaimsMetadata,
    buildDisclosureFrame,
    buildJsonSchema,
    formattedClaimFields,
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

    it("puts defaults of child fields into the namespace of their parent", () => {
        const claimsByNamespace = buildClaimsByNamespace([
            {
                path: ["place_of_birth"],
                type: "object",
                namespace: "eu.europa.ec.eudi.pid.1",
                children: [
                    {
                        path: ["locality"],
                        type: "string",
                        defaultValue: "BERLIN",
                    },
                ],
            },
        ] as any);

        expect(claimsByNamespace).toEqual({
            "eu.europa.ec.eudi.pid.1": {
                place_of_birth: { locality: "BERLIN" },
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

describe("buildClaimsMetadata", () => {
    it("publishes array element steps as claims path pointers", () => {
        expect(
            buildClaimsMetadata([
                {
                    path: ["nationalities"],
                    type: "array",
                    children: [{ path: [null], type: "string" }],
                },
                {
                    path: ["addresses"],
                    type: "array",
                    children: [{ path: ["street"], type: "string" }],
                },
                { path: ["places", 0, "city"], type: "string" },
                // No valid index: kept as a string key
                { path: ["odd", -1], type: "string" },
                { path: ["odd", 1.5], type: "string" },
            ]).map((claim) => claim.path),
        ).toEqual([
            ["nationalities"],
            ["nationalities", null],
            ["addresses"],
            ["addresses", null, "street"],
            ["places", 0, "city"],
            ["odd", "-1"],
            ["odd", "1.5"],
        ]);
    });

    it("prefixes child paths with the namespace of their mdoc parent", () => {
        expect(
            buildClaimsMetadata([
                {
                    namespace: "eu.europa.ec.eudi.pid.1",
                    path: ["place_of_birth"],
                    type: "object",
                    children: [
                        { path: ["locality"], type: "string" },
                        { path: ["country"], type: "string" },
                    ],
                },
                {
                    namespace: "eu.europa.ec.eudi.pid.1",
                    path: ["nationality"],
                    type: "array",
                    children: [{ path: [null], type: "string" }],
                },
            ]).map((claim) => claim.path),
        ).toEqual([
            ["eu.europa.ec.eudi.pid.1", "place_of_birth"],
            ["eu.europa.ec.eudi.pid.1", "place_of_birth", "locality"],
            ["eu.europa.ec.eudi.pid.1", "place_of_birth", "country"],
            ["eu.europa.ec.eudi.pid.1", "nationality"],
            ["eu.europa.ec.eudi.pid.1", "nationality", null],
        ]);
    });
});

describe("buildDisclosureFrame", () => {
    it("keeps the frame of configurations without array element paths", () => {
        const fields: ClaimFieldDefinition[] = [
            { path: ["given_name"], type: "string", disclosable: true },
            { path: ["family_name"], type: "string" },
            {
                path: ["address"],
                type: "object",
                disclosable: true,
                children: [
                    {
                        path: ["street_address"],
                        type: "string",
                        disclosable: true,
                    },
                    { path: ["locality"], type: "string", disclosable: false },
                    { path: ["region"], type: "string", disclosable: true },
                ],
            },
            {
                path: ["place_of_birth", "country"],
                type: "string",
                disclosable: true,
            },
            {
                path: ["age_equal_or_over", "18"],
                type: "boolean",
                disclosable: true,
            },
            { path: ["age_equal_or_over"], type: "object", disclosable: true },
            { path: ["given_name"], type: "string", disclosable: true },
        ];

        // Built from the field paths alone, whatever the claims hold
        for (const claims of [{}, { address: [] }, { given_name: "ERIKA" }]) {
            expect(JSON.stringify(buildDisclosureFrame(fields, claims))).toBe(
                '{"_sd":["given_name","address","age_equal_or_over"],"address":{"_sd":["street_address","region"]},"place_of_birth":{"_sd":["country"]},"age_equal_or_over":{"_sd":["18"]}}',
            );
        }
        expect(
            buildDisclosureFrame(
                [{ path: ["given_name"], type: "string" }],
                {},
            ),
        ).toBeUndefined();
    });

    it("makes the array and each of its elements disclosable", () => {
        const fields: ClaimFieldDefinition[] = [
            {
                path: ["nationalities"],
                type: "array",
                disclosable: true,
                children: [{ path: [null], type: "string", disclosable: true }],
            },
        ];

        expect(
            buildDisclosureFrame(fields, { nationalities: ["DE", "FR"] }),
        ).toEqual({
            _sd: ["nationalities"],
            nationalities: { _sd: [0, 1] },
        });
    });

    it("makes only the elements disclosable", () => {
        expect(
            buildDisclosureFrame(
                [
                    {
                        path: ["nationalities", null],
                        type: "string",
                        disclosable: true,
                    },
                ],
                { nationalities: ["DE", "FR", "IT"] },
            ),
        ).toEqual({ nationalities: { _sd: [0, 1, 2] } });
    });

    it("makes a concrete element disclosable once", () => {
        expect(
            buildDisclosureFrame(
                [
                    {
                        path: ["nationalities", 1],
                        type: "string",
                        disclosable: true,
                    },
                    {
                        path: ["nationalities", null],
                        type: "string",
                        disclosable: true,
                    },
                ],
                { nationalities: ["DE", "FR"] },
            ),
        ).toEqual({ nationalities: { _sd: [1, 0] } });
    });

    it("makes properties of array element objects disclosable", () => {
        const fields: ClaimFieldDefinition[] = [
            {
                path: ["addresses"],
                type: "array",
                children: [
                    { path: ["street"], type: "string", disclosable: true },
                    { path: ["city"], type: "string" },
                ],
            },
        ];
        const claims = {
            addresses: [{ street: "A", city: "X" }, { city: "Y" }],
        };

        expect(buildDisclosureFrame(fields, claims)).toEqual({
            addresses: { 0: { _sd: ["street"] }, 1: { _sd: ["street"] } },
        });

        // Elements disclosable too: both levels
        expect(
            buildDisclosureFrame(
                [
                    ...fields,
                    {
                        path: ["addresses", null],
                        type: "object",
                        disclosable: true,
                    },
                ],
                claims,
            ),
        ).toEqual({
            addresses: {
                0: { _sd: ["street"] },
                1: { _sd: ["street"] },
                _sd: [0, 1],
            },
        });
    });

    it("makes elements of nested arrays disclosable", () => {
        expect(
            buildDisclosureFrame(
                [
                    {
                        path: ["matrix", null],
                        type: "array",
                        disclosable: true,
                    },
                    {
                        path: ["matrix", null, null],
                        type: "integer",
                        disclosable: true,
                    },
                ],
                { matrix: [[1, 2], [3], []] },
            ),
        ).toEqual({
            matrix: {
                _sd: [0, 1, 2],
                0: { _sd: [0, 1] },
                1: { _sd: [0] },
            },
        });
    });

    it("adds nothing for empty, missing, short or non-array values", () => {
        const field = (
            path: ClaimFieldDefinition["path"],
        ): ClaimFieldDefinition => ({
            path,
            type: "string",
            disclosable: true,
        });

        for (const claims of [
            { list: [] },
            {},
            { list: "DE" },
            { list: { 0: "DE" } },
            { list: null },
        ]) {
            expect(
                buildDisclosureFrame([field(["list", null])], claims),
            ).toBeUndefined();
        }
        expect(
            buildDisclosureFrame([field(["list", 5])], { list: ["DE"] }),
        ).toBeUndefined();
        expect(
            buildDisclosureFrame([field(["list", 3, "street"])], {
                list: [{ street: "A" }],
            }),
        ).toBeUndefined();
        expect(
            buildDisclosureFrame([field(["list", null, "street"])], {
                list: [],
            }),
        ).toBeUndefined();

        // The array itself stays disclosable when it has no elements
        expect(
            buildDisclosureFrame(
                [{ ...field(["list"]), type: "array" }, field(["list", null])],
                { list: [] },
            ),
        ).toEqual({ _sd: ["list"] });
    });

    it("keeps numbers that are no array index as object keys", () => {
        const field = (
            path: ClaimFieldDefinition["path"],
        ): ClaimFieldDefinition => ({
            path,
            type: "string",
            disclosable: true,
        });

        expect(
            buildDisclosureFrame([field(["odd", -1]), field(["odd", 1.5])], {
                odd: { "-1": "a", "1.5": "b" },
            }),
        ).toEqual({ odd: { _sd: ["-1", "1.5"] } });
    });

    it("survives a path through a segment named _sd", () => {
        const field = (
            path: ClaimFieldDefinition["path"],
        ): ClaimFieldDefinition => ({
            path,
            type: "string",
            disclosable: true,
        });

        // As before the change: the later list replaces what `_sd` held
        expect(
            buildDisclosureFrame(
                [
                    field(["a", "x"]),
                    field(["a", "_sd", "b"]),
                    field(["a", "y"]),
                    field(["list", null]),
                    field(["list", "_sd", "b"]),
                    field(["list", 0]),
                ],
                { list: ["DE"] },
            ),
        ).toEqual({ a: { _sd: ["y"] }, list: { _sd: [0] } });
    });

    it("discloses an array as a whole when only the array is disclosable", () => {
        expect(
            buildDisclosureFrame(
                [
                    {
                        path: ["nationalities"],
                        type: "array",
                        disclosable: true,
                        children: [{ path: [null], type: "string" }],
                    },
                ],
                { nationalities: ["DE", "FR"] },
            ),
        ).toEqual({ _sd: ["nationalities"] });
    });

    it("reads element values through own properties only", () => {
        const claims = JSON.parse('{"__proto__":{"list":["DE"]}}');

        expect(
            buildDisclosureFrame(
                [
                    {
                        path: ["list", null],
                        type: "string",
                        disclosable: true,
                    },
                ],
                claims,
            ),
        ).toBeUndefined();
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
            buildDisclosureFrame: (fields) =>
                buildDisclosureFrame(fields, buildClaims(fields)),
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

        const frame = buildDisclosureFrame(fields, claims) ?? {};
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

describe("claim field format", () => {
    const fields: ClaimFieldDefinition[] = [
        {
            namespace: "eu.europa.ec.eudi.pid.1",
            path: ["eu.europa.ec.eudi.pid.1", "birth_date"],
            type: "string",
            format: "date",
            constraints: { minLength: 10 },
        },
        {
            path: ["history"],
            type: "array",
            children: [{ path: ["at"], type: "string", format: "date-time" }],
        },
        { path: ["name"], type: "string" },
    ];

    it("carries the format into the claims schema", () => {
        const schema = buildJsonSchema(fields) as any;
        expect(
            schema.properties["eu.europa.ec.eudi.pid.1"].properties.birth_date,
        ).toEqual({ minLength: 10, type: "string", format: "date" });
        expect(schema.properties.history.items.properties.at.format).toBe(
            "date-time",
        );
        expect(schema.properties.name.format).toBeUndefined();
    });

    it("lists formatted fields with their claim and namespace paths", () => {
        expect(formattedClaimFields(fields)).toEqual([
            {
                format: "date",
                path: ["eu.europa.ec.eudi.pid.1", "birth_date"],
                namespace: "eu.europa.ec.eudi.pid.1",
                namespacePath: ["birth_date"],
            },
            {
                format: "date-time",
                path: ["history", null, "at"],
                namespace: "history",
                namespacePath: [null, "at"],
            },
        ]);
    });
});
