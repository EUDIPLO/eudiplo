import { describe, expect, it } from "vitest";
import { VALIDATION_SCHEMA } from "./combined.schema.js";
import {
    getActiveSkipFlags,
    SKIP_VALIDATION_SCHEMA,
} from "./skip-validation.schema.js";

describe("SKIP_VALIDATION_SCHEMA", () => {
    it("only declares SKIP_* flags that default to false", () => {
        const keys = SKIP_VALIDATION_SCHEMA.describe().keys ?? {};
        for (const [key, desc] of Object.entries<any>(keys)) {
            expect(key).toMatch(/^SKIP_[A-Z0-9_]+$/);
            expect(desc.type).toBe("boolean");
            expect(desc.flags?.default).toBe(false);
        }
    });

    it("is part of the combined application schema", () => {
        const combinedKeys = VALIDATION_SCHEMA.describe().keys ?? {};
        for (const key of Object.keys(
            SKIP_VALIDATION_SCHEMA.describe().keys ?? {},
        )) {
            expect(combinedKeys).toHaveProperty(key);
        }
    });
});

describe("getActiveSkipFlags", () => {
    it("lists enabled flags from booleans and env strings", () => {
        expect(getActiveSkipFlags(() => undefined)).toEqual([]);
        expect(
            getActiveSkipFlags((key) =>
                key === "SKIP_OVERASKING_CHECK" ? "TRUE" : undefined,
            ),
        ).toEqual(["SKIP_OVERASKING_CHECK"]);
        expect(
            getActiveSkipFlags((key) =>
                key === "SKIP_OVERASKING_CHECK" ? false : undefined,
            ),
        ).toEqual([]);
    });
});
