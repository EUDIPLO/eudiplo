import { describe, expect, it } from "vitest";
import { compileClaimPattern } from "./claim-patterns.js";
import {
    DISPLAY_COLOR_PATTERN,
    duplicateDisplayLocaleMessage,
    findDuplicateDisplayLocales,
    isDisplayColor,
    publishableDisplayEntries,
    readableDisplayColor,
} from "./display-entries.js";

describe("isDisplayColor", () => {
    it.each([
        "#fff",
        "#12107C",
        "rgb(18, 16, 124)",
        "rgb(18,16,124)",
        "rgb(7%, 6.5%, 49%)",
        "rgba(18, 16, 124, 0.5)",
        "rgba(7%, 6%, 49%, .5)",
        "hsl(242, 77%, 27%)",
        "hsla(242.5, 77%, 27%, 1)",
        "transparent",
    ])("accepts the CSS Color Level 3 numerical value %s", (value) => {
        expect(isDisplayColor(value)).toBe(true);
    });

    it.each([
        "",
        "navy",
        "#FFFFF",
        "#12107c80",
        " #fff",
        "rgb(18, 16%, 124)",
        "rgb(18 16 124)",
        "rgb()",
        "RGB(18, 16, 124)",
        "hsl(242, 77, 27)",
        "oklch(40% 0.2 270)",
        "currentColor",
    ])("refuses %j", (value) => {
        expect(isDisplayColor(value)).toBe(false);
    });

    it("is a pattern RE2 runs, so it matches in linear time", () => {
        const re2 = compileClaimPattern(DISPLAY_COLOR_PATTERN);
        expect(re2.test("rgb(18, 16, 124)")).toBe(true);
        expect(re2.test("navy")).toBe(false);
    });
});

describe("findDuplicateDisplayLocales", () => {
    it("reports every repeated locale, compared case-insensitively", () => {
        const duplicates = findDuplicateDisplayLocales([
            { name: "A", locale: "en-US" },
            { name: "B", locale: "de-DE" },
            { name: "C", locale: "en-us" },
            { name: "D" },
            null,
            { name: "E", locale: "de-DE" },
        ]);

        expect(duplicates).toEqual([
            { index: 2, firstIndex: 0, locale: "en-us" },
            { index: 5, firstIndex: 1, locale: "de-DE" },
        ]);
        expect(duplicateDisplayLocaleMessage(duplicates[0])).toBe(
            "Locale en-us is already used by display entry 1. OID4VCI allows one display entry per language.",
        );
    });

    it("finds nothing in distinct locales", () => {
        expect(
            findDuplicateDisplayLocales([
                { locale: "en-US" },
                { locale: "en-GB" },
            ]),
        ).toEqual([]);
    });
});

describe("readableDisplayColor", () => {
    it("trims and lowercases function names, and gives up on everything else", () => {
        expect(readableDisplayColor(" #FFF ")).toBe("#FFF");
        expect(readableDisplayColor("RGB(18, 16, 124)")).toBe("rgb(18, 16, 124)");
        expect(readableDisplayColor("Transparent")).toBe("transparent");
        expect(readableDisplayColor("navy")).toBeUndefined();
        expect(readableDisplayColor("")).toBeUndefined();
        expect(readableDisplayColor(255)).toBeUndefined();
    });
});

describe("publishableDisplayEntries", () => {
    it("leaves out unreadable colors and later entries for a locale", () => {
        const display = [
            { name: "A", locale: "en-US", background_color: "#fff", text_color: "navy" },
            { name: "B", locale: "de-DE", background_color: " RGB(1, 2, 3)" },
            { name: "C", locale: "EN-us", background_color: "#000" },
        ];

        expect(publishableDisplayEntries(display)).toEqual([
            { name: "A", locale: "en-US", background_color: "#fff" },
            { name: "B", locale: "de-DE", background_color: "rgb(1, 2, 3)" },
        ]);
        // The stored entries stay as they are.
        expect(display[0].text_color).toBe("navy");
    });

    it("returns valid entries unchanged", () => {
        const display = [{ name: "A", locale: "en-US", text_color: "#fff" }];
        expect(publishableDisplayEntries(display)).toEqual(display);
        expect(publishableDisplayEntries(display)[0]).toBe(display[0]);
    });
});
