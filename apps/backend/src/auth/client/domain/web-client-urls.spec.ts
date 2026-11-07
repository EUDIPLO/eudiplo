import { describe, expect, it } from "vitest";
import { isWebClientUrl } from "./web-client-urls.js";

describe("isWebClientUrl", () => {
    it("accepts http and https URLs, also with a path", () => {
        for (const url of [
            "https://console.example",
            "https://console.example/",
            "https://example.com/eudiplo-client/",
            "http://localhost:4200",
        ]) {
            expect(isWebClientUrl(url)).toBe(true);
        }
    });

    it("refuses wildcards, other schemes, queries, fragments and credentials", () => {
        for (const url of [
            "*",
            "https://*",
            "https://console.example/*",
            "console.example",
            "javascript:alert(1)",
            "ftp://console.example",
            "https://console.example/?a=1",
            "https://console.example/?",
            "https://console.example/#top",
            "https://user:pass@console.example",
            "https://user@console.example",
            "https://:pass@console.example",
        ]) {
            expect(isWebClientUrl(url)).toBe(false);
        }
    });
});
