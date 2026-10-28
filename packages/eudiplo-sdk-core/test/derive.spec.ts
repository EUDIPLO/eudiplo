import { describe, expect, it } from "vitest";
import {
  buildClaims,
  buildClaimsByNamespace,
  buildClaimsMetadata,
  buildDisclosureFrame,
  buildJsonSchema,
} from "../src/config";
import type { ClaimFieldDefinition } from "../src/config";

describe("config derive helpers", () => {
  it("builds SD-JWT runtime artifacts from fields", () => {
    const fields: ClaimFieldDefinition[] = [
      {
        path: ["given_name"],
        type: "string",
        defaultValue: "Erika",
        disclosable: true,
        display: [{ locale: "en-US", name: "Given Name" }],
      },
      {
        path: ["address", "locality"],
        type: "string",
        defaultValue: "Berlin",
        disclosable: true,
        mandatory: true,
        display: [{ locale: "en-US", name: "City" }],
      },
    ];

    expect(buildClaims(fields)).toEqual({
      given_name: "Erika",
      address: {
        locality: "Berlin",
      },
    });

    expect(buildDisclosureFrame(fields)).toEqual({
      _sd: ["given_name"],
      address: {
        _sd: ["locality"],
      },
    });

    expect(buildClaimsMetadata(fields)).toEqual([
      {
        path: ["given_name"],
        display: [{ name: "Given Name", locale: "en-US" }],
      },
      {
        path: ["address", "locality"],
        mandatory: true,
        display: [{ name: "City", locale: "en-US" }],
      },
    ]);

    expect(buildJsonSchema(fields)).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        given_name: {
          type: "string",
          title: "Given Name",
        },
        address: {
          type: "object",
          properties: {
            locality: {
              type: "string",
              title: "City",
            },
          },
          required: ["locality"],
        },
      },
    });
  });

  it("builds mDOC claims by namespace", () => {
    const fields: ClaimFieldDefinition[] = [
      {
        path: ["given_name"],
        namespace: "eu.europa.ec.eudi.pid.1",
        type: "string",
        defaultValue: "Erika",
      },
      {
        path: ["birth_date"],
        namespace: "eu.europa.ec.eudi.pid.1",
        type: "string",
        defaultValue: "1964-08-12",
      },
    ];

    expect(buildClaimsByNamespace(fields)).toEqual({
      "eu.europa.ec.eudi.pid.1": {
        given_name: "Erika",
        birth_date: "1964-08-12",
      },
    });
  });

  it("handles empty fields", () => {
    expect(buildClaims([])).toEqual({});
    expect(buildClaimsMetadata([])).toEqual([]);
    expect(buildClaimsByNamespace([])).toEqual({});
    expect(buildDisclosureFrame([])).toBeUndefined();
    expect(buildJsonSchema([])).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {},
    });
  });

  it("builds array schemas using items for indexed child paths", () => {
    const fields: ClaimFieldDefinition[] = [
      {
        path: ["nationalities"],
        type: "array",
        mandatory: true,
        display: [{ locale: "en-US", name: "Nationalities" }],
      },
      {
        path: ["nationalities", 0],
        type: "string",
        display: [{ locale: "en-US", name: "Nationality" }],
      },
    ];

    expect(buildJsonSchema(fields)).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        nationalities: {
          type: "array",
          title: "Nationalities",
          items: {
            type: "string",
            title: "Nationality",
          },
        },
      },
      required: ["nationalities"],
    });
  });

  it("infers array item step for children when parent type is array", () => {
    const fields: ClaimFieldDefinition[] = [
      {
        path: ["driving_privileges"],
        type: "array",
        defaultValue: [
          {
            vehicle_category_code: "B",
            codes: [{ code: "B96" }],
          },
        ],
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
              {
                path: ["code"],
                type: "string",
                mandatory: true,
              },
            ],
          },
        ],
      },
    ];

    expect(buildClaims(fields)).toEqual({
      driving_privileges: [
        {
          vehicle_category_code: "B",
          codes: [{ code: "B96" }],
        },
      ],
    });

    expect(buildJsonSchema(fields)).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        driving_privileges: {
          type: "array",
          items: {
            type: "object",
            properties: {
              vehicle_category_code: {
                type: "string",
              },
              codes: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    code: {
                      type: "string",
                    },
                  },
                  required: ["code"],
                },
              },
            },
            required: ["vehicle_category_code"],
          },
        },
      },
    });
  });

  it("rejects relative array child paths that start with null", () => {
    const fields: ClaimFieldDefinition[] = [
      {
        path: ["driving_privileges"],
        type: "array",
        children: [
          {
            path: [null, "vehicle_category_code"],
            type: "string",
          },
        ],
      },
    ];

    expect(() => buildJsonSchema(fields)).toThrow(
      "Relative child paths under array parents must not start with null"
    );
  });

  it("treats a [null] child path under an array parent as the items", () => {
    const relative: ClaimFieldDefinition[] = [
      {
        path: ["nationalities"],
        type: "array",
        children: [{ path: [null], type: "string", defaultValue: "DE" }],
      },
    ];
    const absolute: ClaimFieldDefinition[] = [
      {
        path: ["nationalities"],
        type: "array",
        children: [
          { path: ["nationalities", null], type: "string", defaultValue: "DE" },
        ],
      },
    ];

    expect(buildJsonSchema(relative)).toEqual(buildJsonSchema(absolute));
    expect(buildClaims(relative)).toEqual(buildClaims(absolute));
  });

  it("keeps only JSON Schema keywords from constraints", () => {
    const fields: ClaimFieldDefinition[] = [
      {
        path: ["birth_date"],
        type: "string",
        constraints: {
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          minLength: 10,
          widget: {
            formlyConfig: {
              template: "<img src=x onerror=alert(1)>",
              props: { safeHtml: true },
            },
          },
          "x-ui": { hidden: true },
          $ref: "#/$defs/other",
        },
      },
      {
        path: ["nationalities"],
        type: "array",
        constraints: {
          items: {
            type: "string",
            title: "Nationality",
            widget: { formlyConfig: { template: "<b>x</b>" } },
          },
          anyOf: [{ minItems: 1, widget: {} }, "not a schema"],
        },
      },
      {
        path: ["extras"],
        type: "object",
        constraints: {
          additionalProperties: true,
          properties: { note: { type: "string", widget: {} } },
          propertyNames: { pattern: "^[a-z]+$", widget: {} },
        },
      },
    ];

    expect(buildJsonSchema(fields).properties).toEqual({
      birth_date: {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        minLength: 10,
      },
      nationalities: {
        type: "array",
        items: { type: "string", title: "Nationality" },
        anyOf: [{ minItems: 1 }],
      },
      extras: {
        type: "object",
        additionalProperties: true,
        properties: { note: { type: "string" } },
        propertyNames: { pattern: "^[a-z]+$" },
      },
    });
  });

  it("keeps a __proto__ property name as data", () => {
    const constraints = JSON.parse(
      '{"properties":{"__proto__":{"type":"string","widget":{}}}}',
    );
    const schema = buildJsonSchema([
      { path: ["extras"], type: "object", constraints },
    ]);
    const extras = schema.properties?.extras as Record<string, unknown>;
    const properties = extras.properties as Record<string, unknown>;

    expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(properties, "__proto__")?.value).toEqual({
      type: "string",
    });
  });
});
