import { describe, expect, it } from "vitest";
import { defaultKeyChainsOrNull } from "./tenant-data.js";

describe("defaultKeyChainsOrNull", () => {
    it("stores a missing or empty map as no default key chains", () => {
        expect(defaultKeyChainsOrNull(undefined)).toBeNull();
        expect(defaultKeyChainsOrNull(null)).toBeNull();
        expect(defaultKeyChainsOrNull({})).toBeNull();
    });

    it("keeps the named default key chains", () => {
        expect(defaultKeyChainsOrNull({ access: "registrar" })).toEqual({
            access: "registrar",
        });
    });
});
