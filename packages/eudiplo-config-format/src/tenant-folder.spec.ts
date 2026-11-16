import { describe, expect, it } from "vitest";
import {
    compareCodePoints,
    imageContentType,
    isTenantFolderImage,
    TENANT_FOLDER_RESOURCES,
    TENANT_FOLDER_TENANT,
} from "./tenant-folder.js";

describe("tenant folder layout", () => {
    it("places every kind once", () => {
        const kinds = [TENANT_FOLDER_TENANT, ...TENANT_FOLDER_RESOURCES].map(
            (resource) => resource.kind,
        );
        expect(new Set(kinds).size).toBe(kinds.length);
    });

    it("skips files that tools put into images/", () => {
        expect(isTenantFolderImage(".gitkeep")).toBe(false);
        expect(isTenantFolderImage(".DS_Store")).toBe(false);
        expect(isTenantFolderImage("Thumbs.db")).toBe(false);
        expect(isTenantFolderImage("desktop.ini")).toBe(false);
        expect(isTenantFolderImage("logo.png")).toBe(true);
        // A hidden image still is one, as in 9.x.
        expect(isTenantFolderImage(".logo.png")).toBe(true);
    });

    it("maps image extensions to content types", () => {
        expect(imageContentType("Logo.PNG")).toBe("image/png");
        expect(imageContentType("icon.svg")).toBe("image/svg+xml");
        expect(imageContentType("README")).toBe("application/octet-stream");
    });

    it("orders by code point, independent of the locale", () => {
        const names = ["b", "B", "a", "ä", "A"];
        expect([...names].sort(compareCodePoints)).toEqual([
            "A",
            "B",
            "a",
            "b",
            "ä",
        ]);
    });
});
