import { describe, expect, it } from "vitest";
import { isDateTime, isFullDate } from "./claim-formats.js";

describe("claim field formats", () => {
    it.each(["1964-08-12", "2024-02-29", "2000-02-29", "0001-01-01"])(
        "accepts the full-date %s",
        (value) => expect(isFullDate(value)).toBe(true),
    );

    it.each([
        "1964-8-12",
        "1964-13-01",
        "1964-00-10",
        "2023-02-29",
        "1900-02-29",
        "2026-04-31",
        "1964-08-12T00:00:00Z",
        " 1964-08-12",
        "",
    ])("refuses %j as full-date", (value) =>
        expect(isFullDate(value)).toBe(false),
    );

    it.each([
        "2026-11-20T10:15:30Z",
        "2026-11-20t10:15:30z",
        "2026-11-20T10:15:30.123+02:00",
        "2026-11-20T23:59:59-23:59",
    ])("accepts the date-time %s", (value) =>
        expect(isDateTime(value)).toBe(true),
    );

    it.each([
        "2026-11-20",
        "2026-11-20T10:15:30",
        "2026-11-20 10:15:30Z",
        "2026-11-20T24:00:00Z",
        "2026-12-31T23:59:60Z",
        "2026-11-20T10:60:00Z",
        "2026-11-20T10:15:30+24:00",
        "2026-02-30T10:15:30Z",
    ])("refuses %j as date-time", (value) =>
        expect(isDateTime(value)).toBe(false),
    );
});
