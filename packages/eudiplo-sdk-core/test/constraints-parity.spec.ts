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
} from "../src/config/constraints";

// Keywords that must stay refused, also where a form renderer reads them
const REFUSED = ["widget", "format", "$ref", "$defs", "nullable", "x-ui"];

function constraintsWithEveryKeyword(): Record<string, unknown> {
  const subschema = { minLength: 1, widget: {} };
  return Object.fromEntries([
    ...CONSTRAINT_VALUE_KEYWORDS.map((keyword) => [keyword, 1]),
    ...CONSTRAINT_SCHEMA_KEYWORDS.map((keyword) => [keyword, subschema]),
    ...CONSTRAINT_SCHEMA_LIST_KEYWORDS.map((keyword) => [keyword, [subschema, true]]),
    ...CONSTRAINT_SCHEMA_MAP_KEYWORDS.map((keyword) => [keyword, { a: subschema }]),
    ...REFUSED.map((keyword) => [keyword, { minLength: 1 }]),
  ]);
}

describe("constraint allow-list", () => {
  it("has the same keywords as the backend's allow-list", () => {
    expect([...VALUE_KEYWORDS]).toEqual([...CONSTRAINT_VALUE_KEYWORDS]);
    expect([...SCHEMA_KEYWORDS]).toEqual([...CONSTRAINT_SCHEMA_KEYWORDS]);
    expect([...SCHEMA_LIST_KEYWORDS]).toEqual([...CONSTRAINT_SCHEMA_LIST_KEYWORDS]);
    expect([...SCHEMA_MAP_KEYWORDS]).toEqual([...CONSTRAINT_SCHEMA_MAP_KEYWORDS]);
  });

  it("sanitizes like the backend", () => {
    const constraints = constraintsWithEveryKeyword();

    expect(sanitizeConstraints(constraints)).toEqual(
      sanitizeClaimConstraints(constraints).constraints,
    );
    for (const keyword of REFUSED) {
      expect(sanitizeConstraints(constraints)).not.toHaveProperty(keyword);
    }
  });
});
