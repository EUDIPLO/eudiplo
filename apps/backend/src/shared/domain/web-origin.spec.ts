import { describe, expect, it } from "vitest";
import { isSerializedWebOrigin } from "./web-origin.js";

describe("isSerializedWebOrigin", () => {
    it.each([
        "https://shop.example",
        "https://shop.example:8443",
        "http://localhost:4200",
        "http://127.0.0.1:3000",
        "https://[::1]:8443",
    ])("accepts %s", (value) => {
        expect(isSerializedWebOrigin(value)).toBe(true);
    });

    it.each([
        "https://shop.example/",
        "https://shop.example/checkout",
        "https://Shop.example",
        "https://shop.example:443",
        "https://user@shop.example",
        "shop.example",
        "ftp://shop.example",
        "data:text/html,hi",
        "*",
        "https://shop.example?x=1",
        "null",
        "",
    ])("refuses %s", (value) => {
        expect(isSerializedWebOrigin(value)).toBe(false);
    });
});
