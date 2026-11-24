import { describe, expect, it } from "vitest";
import {
    kmsPathLeavesBaseUrl,
    kmsRequestPathFields,
} from "./kms-request-path.js";

describe("kmsPathLeavesBaseUrl", () => {
    it.each([
        ["a path", "https://kms.example", "/keys"],
        ["a path below a base path", "https://kms.example/v1/", "/keys"],
        ["a path with a query", "https://kms.example", "/keys?tenant=a"],
    ])("accepts %s", (_label, baseUrl, path) => {
        expect(kmsPathLeavesBaseUrl(baseUrl, path)).toBe(false);
    });

    it.each([
        [
            "userinfo that makes baseUrl the user",
            "https://kms.example",
            "@other.example/keys",
        ],
        ["a longer host name", "https://kms.example", ".other.example/keys"],
        ["another port", "https://kms.example", ":8443/keys"],
        ["a password", "https://user@kms.example", ":secret@kms.example/keys"],
        ["a baseUrl that is no URL", "not a url", "/keys"],
    ])("refuses %s", (_label, baseUrl, path) => {
        expect(kmsPathLeavesBaseUrl(baseUrl, path)).toBe(true);
    });
});

describe("kmsRequestPathFields", () => {
    it("names the settings appended to baseUrl", () => {
        expect(kmsRequestPathFields({ type: "http" })).toEqual([
            "keysPath",
            "healthPath",
        ]);
        expect(kmsRequestPathFields({ type: "csc" })).toEqual(["apiPath"]);
        expect(kmsRequestPathFields({ type: "vault" })).toEqual([]);
    });
});
