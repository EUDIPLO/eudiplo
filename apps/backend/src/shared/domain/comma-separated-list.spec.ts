import { describe, expect, it } from "vitest";
import { splitCommaSeparatedList } from "./comma-separated-list.js";

describe("splitCommaSeparatedList", () => {
    it("returns no entries for an unset or empty value", () => {
        expect(splitCommaSeparatedList(undefined)).toEqual([]);
        expect(splitCommaSeparatedList("")).toEqual([]);
        expect(splitCommaSeparatedList(" , ")).toEqual([]);
    });

    it("trims entries and drops empty ones", () => {
        expect(
            splitCommaSeparatedList(
                " https://console.example ,,http://localhost:4200 ",
            ),
        ).toEqual(["https://console.example", "http://localhost:4200"]);
    });
});
