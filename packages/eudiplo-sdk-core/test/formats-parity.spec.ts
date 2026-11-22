import { describe, expect, it } from "vitest";
import * as backend from "../../eudiplo-config-format/src/claim-formats";
import * as sdk from "../src/config/formats";

const SAMPLES = [
  "1964-08-12",
  "2024-02-29",
  "2023-02-29",
  "1964-13-01",
  "1964-08-12T00:00:00Z",
  "2026-11-20T10:15:30.123+02:00",
  "2026-11-20T10:15:30",
  "2026-12-31T23:59:60Z",
  "2026-11-20T10:15:30+24:00",
  "",
];

describe("claim field format parity", () => {
  it("has the same formats as the backend", () => {
    expect([...sdk.CLAIM_FIELD_FORMATS]).toEqual([
      ...backend.CLAIM_FIELD_FORMATS,
    ]);
  });

  it.each(SAMPLES)("judges %j like the backend", (value) => {
    for (const format of backend.CLAIM_FIELD_FORMATS) {
      expect(sdk.CLAIM_FIELD_FORMAT_VALIDATORS[format](value)).toBe(
        backend.CLAIM_FIELD_FORMAT_VALIDATORS[format](value),
      );
    }
  });
});
