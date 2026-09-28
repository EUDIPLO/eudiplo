import { describe, expect, it } from "vitest";
import { CredentialVerifierFormatRegistry } from "./credential-verifier-format-registry.js";

describe("CredentialVerifierFormatRegistry", () => {
    it("resolves registered mDOC and SD-JWT formats", () => {
        const mdoc = { format: "mso_mdoc", verify: async () => ({}) } as any;
        const sdJwt = { format: "dc+sd-jwt", verify: async () => ({}) } as any;
        const registry = new CredentialVerifierFormatRegistry([mdoc, sdJwt]);

        expect(registry.resolve("mso_mdoc")).toBe(mdoc);
        expect(registry.resolve("dc+sd-jwt")).toBe(sdJwt);
    });

    it("rejects unsupported formats", () => {
        const registry = new CredentialVerifierFormatRegistry([]);

        expect(() => registry.resolve("unknown")).toThrow(
            "Unsupported credential verifier format 'unknown'",
        );
    });
});
