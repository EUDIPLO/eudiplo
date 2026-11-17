import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/runtime.js";
import type { CommandContext } from "../src/types.js";

describe("eudiplo config editor setup", () => {
    it("installs bundled schemas and configures scoped VS Code associations", async () => {
        const { context, output, cwd } = await createContext();

        const code = await runCli(["config", "editor", "setup"], context);

        expect(code).toBe(0);
        expect(output.stdout).toContain(
            "Configured VS Code JSON Schema support",
        );

        const settings = parse(
            await readFile(join(cwd, ".vscode", "settings.json"), "utf8"),
        ) as Record<string, unknown>;
        const associations = settings["json.schemas"] as Array<{
            fileMatch: string[];
            url: string;
        }>;
        expect(associations).toContainEqual({
            fileMatch: ["/config/*/presentation/*.json"],
            url: "./.vscode/eudiplo-schemas/PresentationConfigFile.schema.json",
        });
        expect(associations).toContainEqual({
            fileMatch: ["/config/kms.json", "/config/*/kms.json"],
            url: "./.vscode/eudiplo-schemas/KmsConfigFile.schema.json",
        });
        expect(associations).toContainEqual({
            fileMatch: ["/config/*/clients/*.json"],
            url: "./.vscode/eudiplo-schemas/ClientConfigFile.schema.json",
        });
        await expect(
            access(
                join(
                    cwd,
                    ".vscode",
                    "eudiplo-schemas",
                    "PresentationConfigFile.schema.json",
                ),
            ),
        ).resolves.toBeUndefined();
        await expect(
            access(
                join(
                    cwd,
                    ".vscode",
                    "eudiplo-schemas",
                    "PresentationConfigCreateDto.schema.json",
                ),
            ),
        ).resolves.toBeUndefined();
    });

    it("preserves comments and unmanaged associations and is idempotent", async () => {
        const { context, cwd } = await createContext();
        const vscodePath = join(cwd, ".vscode");
        await mkdir(vscodePath, { recursive: true });
        await writeFile(
            join(vscodePath, "settings.json"),
            `{
  // Kept by the EUDIPLO CLI.
  "editor.formatOnSave": true,
  "json.schemas": [
    {
      "fileMatch": ["/custom/*.json"],
      "url": "./custom.schema.json"
    }
  ],
}
`,
            "utf8",
        );

        expect(
            await runCli(
                [
                    "config",
                    "editor",
                    "setup",
                    ".",
                    "--config-directory",
                    "tenant-config",
                ],
                context,
            ),
        ).toBe(0);
        expect(
            await runCli(
                [
                    "config",
                    "editor",
                    "setup",
                    ".",
                    "--config-directory",
                    "tenant-config",
                ],
                context,
            ),
        ).toBe(0);

        const settingsText = await readFile(
            join(vscodePath, "settings.json"),
            "utf8",
        );
        expect(settingsText).toContain("// Kept by the EUDIPLO CLI.");
        const settings = parse(settingsText) as Record<string, unknown>;
        const associations = settings["json.schemas"] as Array<{
            fileMatch: string[];
            url: string;
        }>;
        expect(
            associations.filter(
                (entry) => entry.url === "./custom.schema.json",
            ),
        ).toHaveLength(1);
        expect(
            associations.filter((entry) =>
                entry.url.startsWith("./.vscode/eudiplo-schemas/"),
            ),
        ).toHaveLength(13);
        expect(associations).toContainEqual({
            fileMatch: ["/tenant-config/*/presentation/*.json"],
            url: "./.vscode/eudiplo-schemas/PresentationConfigFile.schema.json",
        });
    });

    it("rejects config directories outside the workspace", async () => {
        const { context, output } = await createContext();

        const code = await runCli(
            ["config", "editor", "setup", "--config-directory", "../config"],
            context,
        );

        expect(code).toBe(1);
        expect(output.stderr).toContain(
            "Config directory must be inside the VS Code workspace",
        );
    });
});

async function createContext(): Promise<{
    context: CommandContext;
    output: { stdout: string; stderr: string };
    cwd: string;
}> {
    const cwd = await mkdtemp(join(tmpdir(), "eudiplo-cli-config-editor-"));
    const output = { stdout: "", stderr: "" };
    const context: CommandContext = {
        cwd,
        env: { PATH: process.env.PATH },
        stdout: {
            write(chunk: string | Uint8Array) {
                output.stdout += String(chunk);
                return true;
            },
        },
        stderr: {
            write(chunk: string | Uint8Array) {
                output.stderr += String(chunk);
                return true;
            },
        },
        fetch,
    };
    return { context, output, cwd };
}
