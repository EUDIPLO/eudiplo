import { describe, expect, it } from "vitest";
import {
    isAbsoluteUri,
    MalformedStatusReferenceError,
    parseStatusListReference,
} from "./status-list-reference.js";

const URI = "https://issuer.example/status/1";

describe("parseStatusListReference", () => {
    it("returns the uri and idx of a status_list reference", () => {
        expect(
            parseStatusListReference({ status_list: { uri: URI, idx: 0 } }),
        ).toEqual({ uri: URI, idx: 0 });
    });

    it("returns undefined without a status claim", () => {
        expect(parseStatusListReference(undefined)).toBeUndefined();
    });

    it("returns undefined for another status mechanism", () => {
        expect(
            parseStatusListReference({ other_mechanism: { id: "x" } }),
        ).toBeUndefined();
    });

    it.each([
        ["a string", "revoked"],
        ["null", null],
        ["an array", [{ status_list: { uri: URI, idx: 0 } }]],
        ["an empty object", {}],
    ])("rejects a status claim that is %s", (_, status) => {
        expect(() => parseStatusListReference(status)).toThrow(
            MalformedStatusReferenceError,
        );
    });

    it.each([
        ["null", null],
        ["a string", URI],
        ["an array", [URI, 0]],
    ])("rejects a status_list that is %s", (_, statusList) => {
        expect(() =>
            parseStatusListReference({ status_list: statusList }),
        ).toThrow("The status_list claim is not a JSON object");
    });

    it.each([
        ["no uri", { idx: 0 }],
        ["an empty uri", { uri: "", idx: 0 }],
        ["a uri that is not a URI", { uri: "not a uri", idx: 0 }],
        ["a relative uri", { uri: "/status/1", idx: 0 }],
        ["a numeric uri", { uri: 1, idx: 0 }],
    ])("rejects a reference with %s", (_, statusList) => {
        expect(() =>
            parseStatusListReference({ status_list: statusList }),
        ).toThrow("The status_list claim has no uri that is an absolute URI");
    });

    it.each([
        ["no idx", { uri: URI }],
        ["a string idx", { uri: URI, idx: "7" }],
        ["a negative idx", { uri: URI, idx: -1 }],
        ["a fractional idx", { uri: URI, idx: 1.5 }],
        ["an idx beyond the safe integers", { uri: URI, idx: 2 ** 53 }],
        ["a null idx", { uri: URI, idx: null }],
    ])("rejects a reference with %s", (_, statusList) => {
        expect(() =>
            parseStatusListReference({ status_list: statusList }),
        ).toThrow("The status_list claim has no non-negative integer idx");
    });
});

describe("isAbsoluteUri", () => {
    it.each([
        URI,
        "http://127.0.0.1:3000/status/1?x=1#y",
        "urn:example:status:1",
    ])("accepts %s", (value) => {
        expect(isAbsoluteUri(value)).toBe(true);
    });

    it.each([
        "",
        "not a uri",
        "/status/1",
        "//issuer.example/status/1",
        " https://issuer.example/status/1",
        "https://issuer.example/status list",
        "https://issuer.example/status/1\n",
        "https://exämple.org/status/1",
        "1https://issuer.example",
        // URI characters only, but no URL
        "https://[status/1",
        "https://issuer.example:99999/status/1",
    ])("rejects %j", (value) => {
        expect(isAbsoluteUri(value)).toBe(false);
    });
});
