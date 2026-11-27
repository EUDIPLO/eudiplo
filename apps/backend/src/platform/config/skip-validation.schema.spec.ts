import { describe, expect, it } from "vitest";
import { VALIDATION_SCHEMA } from "./combined.schema.js";
import {
    getActiveSkipFlags,
    removedSkipFlagError,
    SKIP_VALIDATION_SCHEMA,
    skippedProtection,
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

    it("names the protection every flag disables for the startup warning", () => {
        for (const key of Object.keys(
            SKIP_VALIDATION_SCHEMA.describe().keys ?? {},
        )) {
            expect(skippedProtection(key)).toEqual(expect.any(String));
        }
        expect(skippedProtection("SKIP_OVERASKING_CHECK")).toBe(
            "overasking prevention of registration certificates",
        );
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

describe("removed SKIP_* flags", () => {
    it("refuses SKIP_TRUST_AUTHORITY=true and names allowUntrustedIssuers", () => {
        expect(
            removedSkipFlagError({ SKIP_TRUST_AUTHORITY: "true" }),
        ).toContain("allowUntrustedIssuers");
        expect(removedSkipFlagError({ SKIP_TRUST_AUTHORITY: true })).toEqual(
            expect.any(String),
        );
    });

    it("accepts the flag unset or false", () => {
        expect(removedSkipFlagError({})).toBeUndefined();
        expect(
            removedSkipFlagError({ SKIP_TRUST_AUTHORITY: "false" }),
        ).toBeUndefined();
    });

    it("makes the combined schema reject the environment", () => {
        const { error } = VALIDATION_SCHEMA.validate(
            {
                SKIP_TRUST_AUTHORITY: "true",
                MASTER_SECRET: "x".repeat(40),
                AUTH_CLIENT_ID: "admin",
                AUTH_CLIENT_SECRET: "secret",
            },
            { allowUnknown: true },
        );
        expect(error?.message).toContain("SKIP_TRUST_AUTHORITY was removed");
    });
});
