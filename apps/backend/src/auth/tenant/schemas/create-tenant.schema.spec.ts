import { describe, expect, test } from "vitest";
import { DEFAULT_KEY_CHAIN_ENTRIES } from "../domain/tenant-data.js";
import {
    CreateTenantSchema,
    UpdateTenantSchema,
} from "./create-tenant.schema.js";
import { DefaultKeyChainsSchema } from "./key-chain-defaults.schema.js";

describe("tenant request schemas", () => {
    test("allows create without a description", () => {
        expect(
            CreateTenantSchema.parse({ id: "tenant", name: "Tenant" }),
        ).not.toHaveProperty("description");
    });

    test.each(["acme", "tenant-1", "tenant_a", "9", "a".repeat(63)])(
        "accepts the tenant ID %j",
        (id) => {
            expect(CreateTenantSchema.safeParse({ id }).success).toBe(true);
        },
    );

    test.each([
        "",
        " ",
        ".",
        "..",
        ".hidden",
        "-tenant",
        "Acme",
        "acme.",
        "tenant.a",
        "kms.json",
        "a".repeat(64),
        "x/../victim",
        String.raw`x\..\victim`,
        "tenant a",
        "tenant\0a",
    ])("rejects the tenant ID %j", (id) => {
        expect(CreateTenantSchema.safeParse({ id }).success).toBe(false);
    });

    test("trims the tenant ID", () => {
        expect(CreateTenantSchema.parse({ id: " acme " }).id).toBe("acme");
    });

    test("trims non-blank create descriptions", () => {
        expect(
            CreateTenantSchema.parse({
                id: "tenant",
                name: "Tenant",
                description: "  Example tenant  ",
            }).description,
        ).toBe("Example tenant");
    });

    test.each(["", "   "])(
        "rejects a blank create description (%j)",
        (description) => {
            expect(
                CreateTenantSchema.safeParse({
                    id: "tenant",
                    name: "Tenant",
                    description,
                }).success,
            ).toBe(false);
        },
    );

    test("keeps omitted update fields omitted without applying create defaults", () => {
        expect(UpdateTenantSchema.parse({})).toEqual({});
    });

    test("trims non-blank update descriptions", () => {
        expect(
            UpdateTenantSchema.parse({ description: "  Updated  " }),
        ).toEqual({ description: "Updated" });
    });

    test("allows an update description to be cleared", () => {
        expect(UpdateTenantSchema.parse({ description: null })).toEqual({
            description: null,
        });
    });

    test.each(["", "   "])(
        "rejects a blank update description (%j)",
        (description) => {
            expect(UpdateTenantSchema.safeParse({ description }).success).toBe(
                false,
            );
        },
    );

    test("rejects create-only properties in updates", () => {
        expect(
            UpdateTenantSchema.safeParse({ roles: ["clients:manage"] }).success,
        ).toBe(false);
        expect(UpdateTenantSchema.safeParse({ id: "tenant" }).success).toBe(
            false,
        );
    });

    test("accepts only known usage types as default key chains", () => {
        expect(
            DefaultKeyChainsSchema.safeParse({ access: "registrar" }).success,
        ).toBe(true);
        expect(
            DefaultKeyChainsSchema.safeParse({ attestation: "pid" }).success,
        ).toBe(false);
    });

    test("leaves the default key chains out of the tenant settings", () => {
        expect(
            UpdateTenantSchema.safeParse({
                defaultKeyChains: { access: "registrar" },
            }).success,
        ).toBe(false);
    });

    test("lists the same usage types as the checks of the default key chains", () => {
        expect(Object.keys(DefaultKeyChainsSchema.shape)).toEqual([
            ...DEFAULT_KEY_CHAIN_ENTRIES,
        ]);
    });
});
