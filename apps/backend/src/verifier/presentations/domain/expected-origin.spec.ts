import { describe, expect, it } from "vitest";
import { resolveExpectedOrigin } from "./expected-origin.js";

describe("resolveExpectedOrigin", () => {
    const allowed = ["https://shop.example", "http://localhost:4200"];

    it("returns an allowed requested origin", () => {
        expect(resolveExpectedOrigin("https://shop.example", allowed)).toEqual({
            origin: "https://shop.example",
        });
    });

    it("reduces a page URL to its origin before comparing", () => {
        expect(
            resolveExpectedOrigin("https://SHOP.example:443/checkout", allowed),
        ).toEqual({ origin: "https://shop.example" });
    });

    it("uses the only allowed origin when none is requested", () => {
        expect(
            resolveExpectedOrigin(undefined, ["https://shop.example"]),
        ).toEqual({ origin: "https://shop.example" });
        expect(resolveExpectedOrigin("  ", ["https://shop.example"])).toEqual({
            origin: "https://shop.example",
        });
    });

    it("does not repeat a value that is no origin", () => {
        const requested = `not-an-origin-${"x".repeat(1000)}`;
        const { problem } = resolveExpectedOrigin(requested, allowed);
        expect(problem).toContain("not an http or https origin");
        expect(problem).not.toContain(requested);
    });

    it.each([
        ["no allowlist", undefined],
        ["an empty allowlist", []],
        ["a null allowlist", null],
    ])("accepts any requested origin with %s", (_case, list) => {
        expect(resolveExpectedOrigin("https://shop.example/a", list)).toEqual({
            origin: "https://shop.example",
        });
    });

    it.each([
        ["no allowlist", undefined],
        ["an empty allowlist", []],
    ])("needs an origin with %s", (_case, list) => {
        expect(resolveExpectedOrigin(undefined, list).problem).toContain(
            "needs expected_origin",
        );
    });

    it.each([
        ["a value without scheme and no allowlist", "shop.example", undefined],
        ["an origin that is not allowed", "https://evil.example", allowed],
        ["a subdomain of an allowed origin", "https://a.shop.example", allowed],
        ["another scheme", "http://shop.example", allowed],
        ["another port", "https://shop.example:8443", allowed],
        ["no origin while several are allowed", undefined, allowed],
        ["a value that is no http(s) URL", "javascript:alert(1)", allowed],
        ["a bare host", "shop.example", allowed],
    ])("refuses %s", (_case, requested, list) => {
        const result = resolveExpectedOrigin(requested, list);
        expect(result.origin).toBeUndefined();
        expect(result.problem).toEqual(expect.any(String));
    });
});
