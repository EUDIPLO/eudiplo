import { describe, expect, it } from "vitest";
import { fileAccessHint } from "./file-access-hint.util.js";

const eacces = Object.assign(new Error("EACCES: permission denied"), {
    code: "EACCES",
});

describe("fileAccessHint", () => {
    it("names the user, the file and the opt-out for a permission error", () => {
        const hint = fileAccessHint(
            eacces,
            "/certs/key.pem",
            () => 1000,
            () => 1000,
        );
        expect(hint).toContain("UID 1000 and GID 1000");
        expect(hint).toContain("/certs/key.pem");
        expect(hint).toContain("EUDIPLO_RUN_AS_ROOT=true");
    });

    it("recognizes a dlopen permission error by its text", () => {
        const error = new Error(
            "/usr/lib/softhsm/libsofthsm2.so: cannot open shared object file: Permission denied",
        );
        expect(
            fileAccessHint(
                error,
                "/usr/lib/softhsm/libsofthsm2.so",
                () => 1000,
                () => 1000,
            ),
        ).toContain("EUDIPLO_RUN_AS_ROOT");
    });

    it("adds nothing when the backend runs as root", () => {
        expect(
            fileAccessHint(
                eacces,
                "/certs/key.pem",
                () => 0,
                () => 0,
            ),
        ).toBe("");
    });

    it("adds nothing for other errors", () => {
        const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        expect(
            fileAccessHint(
                enoent,
                "/certs/key.pem",
                () => 1000,
                () => 1000,
            ),
        ).toBe("");
    });
});
