import { describe, expect, it } from "vitest";
import { VALIDATION_SCHEMA } from "./combined.schema.js";
import {
    CORS_VALIDATION_SCHEMA,
    splitCorsOrigins,
} from "./cors-validation.schema.js";

describe("splitCorsOrigins", () => {
    it("returns no origins for an unset or empty value", () => {
        expect(splitCorsOrigins(undefined)).toEqual([]);
        expect(splitCorsOrigins("")).toEqual([]);
        expect(splitCorsOrigins(" , ")).toEqual([]);
    });

    it("trims entries and drops empty ones", () => {
        expect(
            splitCorsOrigins(
                " https://a.example.com ,,http://localhost:4200, ",
            ),
        ).toEqual(["https://a.example.com", "http://localhost:4200"]);
    });
});

describe("CORS_VALIDATION_SCHEMA", () => {
    it("accepts an unset, empty or valid list", () => {
        for (const env of [
            {},
            { CORS_ORIGINS: "" },
            {
                CORS_ORIGINS:
                    "https://console.example.com, http://localhost:4200",
            },
        ]) {
            expect(CORS_VALIDATION_SCHEMA.validate(env).error).toBeUndefined();
        }
    });

    it("rejects a list with invalid origins and names them", () => {
        const { error } = CORS_VALIDATION_SCHEMA.validate({
            CORS_ORIGINS: "https://ok.example.com,https://bad.example.com/",
        });
        expect(error?.message).toContain("https://bad.example.com/");
        expect(error?.message).not.toContain("https://ok.example.com,");
    });

    it("is part of the combined application schema", () => {
        expect(VALIDATION_SCHEMA.describe().keys).toHaveProperty(
            "CORS_ORIGINS",
        );
    });
});
