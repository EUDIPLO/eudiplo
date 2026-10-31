import { describe, expect, it } from "vitest";
import { tenantConfigFolder } from "./tenant-config-folder.util.js";

describe("tenantConfigFolder", () => {
    it("places the tenant's folder in the configuration folder", () => {
        expect(tenantConfigFolder("/config", "tenant-a")).toBe(
            "/config/tenant-a",
        );
    });

    it("resolves a relative or trailing-slash configuration folder", () => {
        expect(tenantConfigFolder("/config/", "tenant-a")).toBe(
            "/config/tenant-a",
        );
        expect(tenantConfigFolder("config", "tenant-a")).toBe(
            `${process.cwd()}/config/tenant-a`,
        );
    });

    it("accepts a root configuration folder", () => {
        expect(tenantConfigFolder("/", "tenant-a")).toBe("/tenant-a");
    });

    it("accepts IDs with dots that are still one folder name", () => {
        expect(tenantConfigFolder("/config", "..tenant")).toBe(
            "/config/..tenant",
        );
        expect(tenantConfigFolder("/config", "tenant.a")).toBe(
            "/config/tenant.a",
        );
    });

    it.each([
        "",
        ".",
        "..",
        "x/../victim",
        "../outside",
        String.raw`x\..\victim`,
        "/etc",
        "tenant\0a",
        "kms.json",
        "KMS.json",
    ])("refuses the tenant ID %j", (tenantId) => {
        expect(tenantConfigFolder("/config", tenantId)).toBeNull();
    });
});
