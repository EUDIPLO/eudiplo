import { cborDecode, cborEncode, DateOnly } from "@owf/mdoc";
import { describe, expect, it } from "vitest";
import { withDateStrings } from "./mdoc-date-values.js";

describe("withDateStrings", () => {
    it("releases full-date elements as issued and tdate elements as JSON date-times", () => {
        // Round trip through CBOR, as a presented IssuerSignedItem value.
        const decoded = cborDecode(
            cborEncode({
                birth_date: new DateOnly("1964-08-12"),
                issuance_date: new Date("2026-11-20T08:15:30Z"),
            }),
        ) as Record<string, unknown>;
        const elements =
            decoded instanceof Map ? Object.fromEntries(decoded) : decoded;

        expect(
            withDateStrings({
                ...elements,
                family_name: "MUSTERMANN",
                age_in_years: 62,
            }),
        ).toEqual({
            birth_date: "1964-08-12",
            issuance_date: "2026-11-20T08:15:30.000Z",
            family_name: "MUSTERMANN",
            age_in_years: 62,
        });
    });
});
