import { describe, expect, it } from "vitest";
import { detectInstallationMethod } from "../src/installation-method.js";

describe("detectInstallationMethod", () => {
    const npmScript = "/usr/lib/node_modules/@eudiplo/cli/dist/index.js";

    it("reports the standalone binary before looking at the environment", () => {
        expect(
            detectInstallationMethod({
                env: { npm_command: "exec" },
                scriptPath: npmScript,
                isSea: true,
                platform: "linux",
            }),
        ).toBe("standalone");
    });

    it("reports the Windows archive for the standalone binary on Windows", () => {
        expect(
            detectInstallationMethod({
                env: {},
                scriptPath: undefined,
                isSea: true,
                platform: "win32",
            }),
        ).toBe("windows-archive");
    });

    it("ignores the platform outside the standalone binary", () => {
        expect(
            detectInstallationMethod({
                env: {},
                scriptPath:
                    "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@eudiplo\\cli\\dist\\index.js",
                isSea: false,
                platform: "win32",
            }),
        ).toBe("npm");
    });

    it("detects npx through npm_command=exec", () => {
        expect(
            detectInstallationMethod({
                env: { npm_command: "exec" },
                scriptPath: npmScript,
                isSea: false,
                platform: "linux",
            }),
        ).toBe("npx");
    });

    it.each([
        "/home/me/.npm/_npx/6f3a/node_modules/@eudiplo/cli/dist/index.js",
        "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\6f3a\\node_modules\\@eudiplo\\cli\\dist\\index.js",
    ])("detects npx through the _npx cache path %s", (scriptPath) => {
        expect(
            detectInstallationMethod({
                env: {},
                scriptPath,
                isSea: false,
                platform: "linux",
            }),
        ).toBe("npx");
    });

    it.each([{}, { npm_command: "run-script" }, { npm_command: "install" }])(
        "treats %j with a global install path as npm",
        (env) => {
            expect(
                detectInstallationMethod({
                    env,
                    scriptPath: npmScript,
                    isSea: false,
                    platform: "linux",
                }),
            ).toBe("npm");
        },
    );

    it("does not treat a path that merely contains npx as npm cache", () => {
        expect(
            detectInstallationMethod({
                env: {},
                scriptPath: "/home/me/npx-tools/cli/index.js",
                isSea: false,
                platform: "linux",
            }),
        ).toBe("npm");
    });

    it("copes with a missing script path", () => {
        expect(
            detectInstallationMethod({
                env: {},
                scriptPath: undefined,
                isSea: false,
                platform: "linux",
            }),
        ).toBe("npm");
    });
});
