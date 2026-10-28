import { describe, expect, it } from "vitest";
import {
  CONSTRAINT_SCHEMA_KEYWORDS,
  CONSTRAINT_SCHEMA_LIST_KEYWORDS,
  CONSTRAINT_SCHEMA_MAP_KEYWORDS,
  CONSTRAINT_VALUE_KEYWORDS,
  sanitizeClaimConstraints,
} from "../../eudiplo-config-format/src/claim-constraints";
import {
  SCHEMA_KEYWORDS,
  SCHEMA_LIST_KEYWORDS,
  SCHEMA_MAP_KEYWORDS,
  VALUE_KEYWORDS,
  sanitizeConstraints,
  unsupportedConstraints,
} from "../src/config/constraints";

// Keywords that must stay refused, also where a form renderer reads them
const REFUSED = ["widget", "format", "$ref", "$defs", "nullable", "x-ui"];

function constraintsWithEveryKeyword(): Record<string, unknown> {
  const subschema = { minLength: 1, widget: {} };
  return Object.fromEntries([
    ...CONSTRAINT_VALUE_KEYWORDS.map((keyword) => [keyword, 1]),
    ...CONSTRAINT_SCHEMA_KEYWORDS.map((keyword) => [keyword, subschema]),
    ...CONSTRAINT_SCHEMA_LIST_KEYWORDS.map((keyword) => [
      keyword,
      [subschema, true, "not a schema"],
    ]),
    ...CONSTRAINT_SCHEMA_MAP_KEYWORDS.map((keyword) => [
      keyword,
      { a: subschema },
    ]),
    ...REFUSED.map((keyword) => [keyword, { minLength: 1 }]),
    ["a~b/c", 1],
  ]);
}

describe("constraint allow-list", () => {
  it("has the same keywords as the backend's allow-list", () => {
    expect([...VALUE_KEYWORDS]).toEqual([...CONSTRAINT_VALUE_KEYWORDS]);
    expect([...SCHEMA_KEYWORDS]).toEqual([...CONSTRAINT_SCHEMA_KEYWORDS]);
    expect([...SCHEMA_LIST_KEYWORDS]).toEqual([
      ...CONSTRAINT_SCHEMA_LIST_KEYWORDS,
    ]);
    expect([...SCHEMA_MAP_KEYWORDS]).toEqual([
      ...CONSTRAINT_SCHEMA_MAP_KEYWORDS,
    ]);
  });

  it("sanitizes like the backend", () => {
    const constraints = constraintsWithEveryKeyword();

    expect(sanitizeConstraints(constraints)).toEqual(
      sanitizeClaimConstraints(constraints).constraints,
    );
    expect(
      unsupportedConstraints(constraints).map(({ pointer }) => pointer),
    ).toEqual(sanitizeClaimConstraints(constraints).removed);
    for (const keyword of REFUSED) {
      expect(sanitizeConstraints(constraints)).not.toHaveProperty(keyword);
    }
  });

  it("names unsupported constraints by their JSON pointer and reason", () => {
    expect(
      unsupportedConstraints({
        pattern: "^a$",
        patern: "^a$",
        items: { type: "string", "x-ui/hint": 1 },
        anyOf: [{ minLength: 1 }, "not a schema"],
        not: "string",
        oneOf: {},
        properties: [],
      }),
    ).toEqual([
      { pointer: "/patern", reason: "unknown-keyword" },
      { pointer: "/items/x-ui~1hint", reason: "unknown-keyword" },
      { pointer: "/anyOf/1", reason: "not-a-schema" },
      { pointer: "/not", reason: "not-a-schema" },
      { pointer: "/oneOf", reason: "not-a-list" },
      { pointer: "/properties", reason: "not-a-map" },
    ]);
    expect(unsupportedConstraints({ minLength: 1 })).toEqual([]);
  });
});
