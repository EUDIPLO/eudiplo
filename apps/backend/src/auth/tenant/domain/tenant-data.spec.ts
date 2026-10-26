import { describe, expect, it } from "vitest";
import { tenantDocumentUpdate } from "./tenant-data.js";

describe("tenantDocumentUpdate", () => {
    it("removes the default key chains when a document leaves them out", () => {
        expect(tenantDocumentUpdate({ name: "Acme" })).toEqual({
            name: "Acme",
            defaultKeyChains: null,
        });
    });

    it("stores an empty map as no default key chains", () => {
        expect(
            tenantDocumentUpdate({ name: "Acme", defaultKeyChains: {} }),
        ).toEqual({ name: "Acme", defaultKeyChains: null });
    });

    it("keeps the named default key chains", () => {
        expect(
            tenantDocumentUpdate({
                name: "Acme",
                defaultKeyChains: { access: "registrar" },
            }).defaultKeyChains,
        ).toEqual({ access: "registrar" });
    });
});
