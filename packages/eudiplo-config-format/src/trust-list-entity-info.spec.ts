import { RE2JS } from "re2js";
import { describe, expect, it } from "vitest";
import {
    isTrustListCountryCode,
    isTrustListEmail,
    isTrustListEntityUri,
    isTrustListLanguageTag,
    isTrustListPhone,
    isTrustListWebsite,
    TRUST_LIST_COUNTRY_CODES,
    TRUST_LIST_EMAIL_PATTERN,
    TRUST_LIST_PHONE_PATTERN,
    TRUST_LIST_WEBSITE_PATTERN,
    trustListCountryCode,
    trustListLanguageTag,
    trustListMailtoUri,
    trustListTelUri,
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

    describe("electronic address (clause 6.5.3.2)", () => {
        it.each([
            "info@example.com",
            "mailto:info@example.com",
            "first.last+tag@mail.example.co.uk",
            "o'neil@xn--bcher-kva.example",
        ])("accepts the e-mail address %j", (value) => {
            expect(isTrustListEmail(value)).toBe(true);
        });

        it.each([
            "",
            "info",
            "mailto:",
            "info@localhost",
            "info@example.com,other@example.com",
            "mailto:info@example.com?subject=hi",
            "MAILTO:info@example.com",
            "in fo@example.com",
            ".info@example.com",
            "info..x@example.com",
            "info@-example.com",
            "info@bücher.example",
            "https://example.com/contact",
            "mailto:https://example.com",
            "a/b@example.com",
            "a=b@example.com",
            "a&b@example.com",
        ])("refuses the e-mail address %j", (value) => {
            expect(isTrustListEmail(value)).toBe(false);
        });

        it("publishes an e-mail address as one mailto: URI", () => {
            expect(trustListMailtoUri("info@example.com")).toBe(
                "mailto:info@example.com",
            );
            expect(trustListMailtoUri("mailto:info@example.com")).toBe(
                "mailto:info@example.com",
            );
        });

        it.each([
            "https://example.com/",
            "https://example.com",
            "http://example.com/about?x=1",
        ])("accepts the web site %j", (value) => {
            expect(isTrustListWebsite(value)).toBe(true);
        });

        it.each([
            "",
            "example.com",
            "ftp://example.com/",
            "mailto:info@example.com",
            "HTTPS://example.com/",
            "https:example.com",
            "https://exa mple.com/",
            "javascript:alert(1)",
        ])("refuses the web site %j", (value) => {
            expect(isTrustListWebsite(value)).toBe(false);
        });

        it.each([
            "+49301234567",
            "tel:+49-30-1234567",
            "+1(555)123.4567",
            "+123",
        ])("accepts the telephone number %j", (value) => {
            expect(isTrustListPhone(value)).toBe(true);
        });

        it.each([
            "",
            "030 1234567",
            "+49 30 1234567",
            "0301234567",
            "+12",
            "+1234567890123456",
            "tel:+49--30",
            "TEL:+49301234567",
        ])("refuses the telephone number %j", (value) => {
            expect(isTrustListPhone(value)).toBe(false);
        });

        it("publishes a telephone number as one tel: URI", () => {
            expect(trustListTelUri("+49301234567")).toBe("tel:+49301234567");
            expect(trustListTelUri("tel:+49301234567")).toBe(
                "tel:+49301234567",
            );
        });

        it("keeps the patterns runnable by RE2", () => {
            const email = RE2JS.compile(TRUST_LIST_EMAIL_PATTERN);
            const phone = RE2JS.compile(TRUST_LIST_PHONE_PATTERN);
            expect(email.matches("mailto:info@example.com")).toBe(true);
            expect(phone.matches("tel:+49-30-1234567")).toBe(true);
            const website = RE2JS.compile(TRUST_LIST_WEBSITE_PATTERN);
            expect(website.matches("https://example.com/about")).toBe(true);
            expect(website.matches("ftp://example.com/")).toBe(false);
        });
    });
});
