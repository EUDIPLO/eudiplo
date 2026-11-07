import { describe, expect, it } from "vitest";
import { webClientAddresses, withoutAnyAddress } from "./keycloak-ui-client.js";

describe("webClientAddresses", () => {
    it("allows the pages under each URL and their origins", () => {
        expect(
            webClientAddresses([
                "https://console.example",
                "https://example.com/eudiplo-client/",
                "https://example.com/other",
            ]),
        ).toEqual({
            redirectUris: [
                "https://console.example/*",
                "https://example.com/eudiplo-client/*",
                "https://example.com/other/*",
            ],
            webOrigins: ["https://console.example", "https://example.com"],
        });
    });

    it("lists a URL given with and without trailing slash once", () => {
        expect(
            webClientAddresses([
                "https://console.example",
                "https://console.example/",
            ]),
        ).toEqual({
            redirectUris: ["https://console.example/*"],
            webOrigins: ["https://console.example"],
        });
    });
});

describe("withoutAnyAddress", () => {
    it("removes the redirect URI * and allows only the origins of the others", () => {
        expect(
            withoutAnyAddress({ redirectUris: ["*"], webOrigins: ["*"] }),
        ).toEqual({ redirectUris: [], webOrigins: ["+"] });
    });

    it("keeps the addresses set in Keycloak", () => {
        expect(
            withoutAnyAddress({
                redirectUris: ["*", "https://console.example/*"],
                webOrigins: ["https://console.example", "*", "+"],
            }),
        ).toEqual({
            redirectUris: ["https://console.example/*"],
            webOrigins: ["https://console.example", "+"],
        });
    });

    it("gives a new client no redirect URI", () => {
        expect(withoutAnyAddress(undefined)).toEqual({
            redirectUris: [],
            webOrigins: ["+"],
        });
    });
});
