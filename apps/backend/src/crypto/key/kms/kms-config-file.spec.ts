import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { kmsConfigFilePath, kmsConfigFileSpec } from "./kms-config-file.js";

const SOURCE = "global kms.json";

function kmsDocument(version: number, spec: unknown) {
    return {
        $schema: `https://eudiplo.dev/schemas/v${version}/KmsConfigFile.schema.json`,
        spec,
    };
}

describe("kmsConfigFileSpec", () => {
    it("returns a bare file unchanged", () => {
        const bare = { providers: [{ id: "db", type: "db" }] };

        expect(kmsConfigFileSpec(bare, SOURCE)).toBe(bare);
    });

    it("unwraps a v1 document into the current spec", () => {
        const spec = {
            defaultProvider: "db",
            providers: [{ id: "db", type: "db" }],
        };

        expect(kmsConfigFileSpec(kmsDocument(1, spec), SOURCE)).toEqual(spec);
    });

    it("rejects a document whose spec fails validation", () => {
        const document = kmsDocument(2, {
            providers: [{ id: "db", type: "db", algorithms: ["RS256"] }],
        });

        expect(() => kmsConfigFileSpec(document, SOURCE)).toThrow(
            BadRequestException,
        );
        expect(() => kmsConfigFileSpec(document, SOURCE)).toThrow(
            /^global kms.json: .*must be equal to one of the allowed values/,
        );
    });

    it("rejects a version newer than supported", () => {
        const document = kmsDocument(99, { providers: [] });

        expect(() => kmsConfigFileSpec(document, SOURCE)).toThrow(
            BadRequestException,
        );
        expect(() => kmsConfigFileSpec(document, SOURCE)).toThrow(
            /newer than supported version/,
        );
    });

    it("rejects unknown envelope properties", () => {
        const document = { ...kmsDocument(2, { providers: [] }), extra: 1 };

        expect(() => kmsConfigFileSpec(document, SOURCE)).toThrow(
            /Unknown configuration envelope property/,
        );
    });
});

describe("kmsConfigFilePath", () => {
    it("places the global file in the configuration folder", () => {
        expect(kmsConfigFilePath("/config")).toBe("/config/kms.json");
    });

    it("accepts a root configuration folder", () => {
        expect(kmsConfigFilePath("/", "tenant-a")).toBe("/tenant-a/kms.json");
    });

    it("places a tenant file in the tenant's folder", () => {
        expect(kmsConfigFilePath("/config", "tenant-a")).toBe(
            "/config/tenant-a/kms.json",
        );
    });

    it.each([
        "..",
        ".",
        "",
        "../other",
        "a/b",
        "/etc",
        "a/../../etc",
        "x/../victim",
        "/config/tenant-b",
        "tenant-a/",
        "a\\b",
        "a\0b",
    ])("has no file for the tenant ID %j", (tenantId) => {
        expect(kmsConfigFilePath("/config", tenantId)).toBeNull();
    });
});
