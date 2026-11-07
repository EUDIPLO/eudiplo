import { describe, expect, it } from "vitest";
import {
    isTrustListCountryCode,
    isTrustListEntityUri,
    isTrustListLanguageTag,
    TRUST_LIST_COUNTRY_CODES,
    trustListCountryCode,
    trustListLanguageTag,
} from "./trust-list-entity-info.js";

describe("trust list entity info (ETSI TS 119 602)", () => {
    it("lists the ISO 3166-1 alpha-2 codes with the clause 6.1.5 exceptions", () => {
        expect(TRUST_LIST_COUNTRY_CODES).toHaveLength(250);
        expect(new Set(TRUST_LIST_COUNTRY_CODES).size).toBe(250);
        for (const code of ["DE", "AT", "UK", "EL", "EU", "US"]) {
            expect(isTrustListCountryCode(code)).toBe(true);
        }
        for (const code of ["GB", "GR", "de", "XX", "12", "DEU", ""]) {
            expect(isTrustListCountryCode(code)).toBe(false);
        }
    });

    it.each([
        ["de", "DE"],
        [" at ", "AT"],
        ["gb", "UK"],
        ["GR", "EL"],
        ["eu", "EU"],
        ["Germany", undefined],
        ["12", undefined],
        [42, undefined],
    ])("reads the country %j as %j", (value, expected) => {
        expect(trustListCountryCode(value)).toBe(expected);
    });

    it.each([
        "en",
        "de-at",
        "zh-hant-tw",
        "sr-latn",
        "es-419",
        "de-ch-1996",
        "en-us-x-twain",
    ])("accepts the language tag %s", (tag) => {
        expect(isTrustListLanguageTag(tag)).toBe(true);
    });

    it.each([
        "EN",
        "de-AT",
        "en_US",
        "e",
        "english language",
        "",
        "de-",
        "x-private",
    ])(
        "refuses the language tag %j",
        (tag) => {
            expect(isTrustListLanguageTag(tag)).toBe(false);
        },
    );

    it("lowercases language tags it can read", () => {
        expect(trustListLanguageTag(" DE-AT ")).toBe("de-at");
        expect(trustListLanguageTag("en_US")).toBeUndefined();
    });

    it("accepts absolute URIs only", () => {
        expect(isTrustListEntityUri("https://example.com/about")).toBe(true);
        expect(isTrustListEntityUri("urn:example:about")).toBe(true);
        expect(isTrustListEntityUri("example.com")).toBe(false);
        expect(isTrustListEntityUri("/about")).toBe(false);
        // Tolerated: the parser only adds the root path.
        expect(isTrustListEntityUri("https://example.com")).toBe(true);
        // Refused: the parser would publish another string than the input.
        expect(isTrustListEntityUri("https://example.com/a b")).toBe(false);
        expect(isTrustListEntityUri("https:\\\\example.com")).toBe(false);
        expect(isTrustListEntityUri(" https://example.com/")).toBe(false);
        expect(isTrustListEntityUri("HTTPS://example.com/")).toBe(false);
    });
});
