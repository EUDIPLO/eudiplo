import { describe, expect, it } from "vitest";
import { normalizeRequestHeaders } from "./util.js";

describe("normalizeRequestHeaders", () => {
    it("normalizes DPoP and bearer authorization schemes", () => {
        const headers = normalizeRequestHeaders({
            authorization: "dpop  access-token",
            dpop: "proof",
        });

        expect(headers.get("authorization")).toBe("DPoP access-token");
        expect(headers.get("dpop")).toBe("proof");
    });

    it("appends string array headers and ignores non-string values", () => {
        const headers = normalizeRequestHeaders({
            authorization: ["bearer token-one", "Bearer token-two"],
            "x-ignored": undefined,
        });

        expect(headers.get("authorization")).toBe(
            "Bearer token-one, Bearer token-two",
        );
        expect(headers.has("x-ignored")).toBe(false);
    });
});
