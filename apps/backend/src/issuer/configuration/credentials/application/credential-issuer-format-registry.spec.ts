import { describe, expect, it } from "vitest";
import type { CredentialIssuerFormat } from "../domain/credential-issuer-format.js";
import { UnsupportedCredentialFormat } from "../domain/credential-issuer-format.js";
import { CredentialFormat } from "../entities/credential.entity.js";
import { CredentialIssuerFormatRegistry } from "./credential-issuer-format-registry.js";

describe("CredentialIssuerFormatRegistry", () => {
    it("resolves each registered format without embedding format branching in callers", () => {
        const sdjwt = {
            format: CredentialFormat.SD_JWT_VC,
        } as CredentialIssuerFormat;
        const mdoc = {
            format: CredentialFormat.MSO_MDOC,
        } as CredentialIssuerFormat;
        const registry = new CredentialIssuerFormatRegistry([sdjwt, mdoc]);

        expect(registry.resolve(CredentialFormat.SD_JWT_VC)).toBe(sdjwt);
        expect(registry.resolve(CredentialFormat.MSO_MDOC)).toBe(mdoc);
    });

    it("rejects unregistered formats with an application error", () => {
        const registry = new CredentialIssuerFormatRegistry([]);

        expect(() => registry.resolve("future-format")).toThrow(
            UnsupportedCredentialFormat,
        );
    });
});
