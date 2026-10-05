import { EventEmitter } from "node:events";
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
    CliConfig,
    CommandContext,
    InstanceConfig,
} from "../src/types.js";

const spawnCalls: string[][] = [];
let exitCodes: Record<string, number> = {};

// No real container runtime is ever invoked.
vi.mock("node:child_process", () => ({
    spawn: vi.fn((_command: string, args: string[]) => {
        spawnCalls.push(args);
        const child = new EventEmitter() as EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
        };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        const verb = args[args.indexOf("--project-name") + 2];
        setImmediate(() => child.emit("close", exitCodes[verb] ?? 0));
        return child;
    }),
}));

const { runUpgradeCommand } = await import("../src/commands/upgrade/action.js");

const envContent = [
    "EUDIPLO_IMAGE=ghcr.io/eudiplo/eudiplo:8.0.2",
    "EUDIPLO_CLIENT_IMAGE=ghcr.io/eudiplo/eudiplo-client:8.0.2",
    "# keep me",
    "MY_SETTING=1",
    "",
].join("\n");

async function setup(
    options: {
        interactive?: boolean;
        answer?: string;
        instance?: Partial<InstanceConfig>;
    } = {},
) {
    const cwd = await mkdtemp(join(tmpdir(), "eudiplo-upgrade-"));
    const bin = join(cwd, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "docker"), "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(join(bin, "docker"), 0o700);
    const envPath = join(cwd, ".eudiplo.env");
    await writeFile(envPath, envContent, { encoding: "utf8", mode: 0o600 });

    const output = { stdout: "", stderr: "" };
    const context: CommandContext = {
        cwd,
        env: { EUDIPLO_CONTAINER_RUNTIME: "docker", PATH: bin },
        interactive: options.interactive ?? false,
        prompt: async () => options.answer ?? "",
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
    const config: CliConfig = {
        defaultInstance: "local",
        instances: {
            local: {
                target: "compose",
                url: "http://localhost:3000",
                projectDirectory: cwd,
                projectName: "eudiplo",
                envFile: ".eudiplo.env",
                ...options.instance,
            },
        },
    };
    return { config, context, output, envPath };
}

function parsed(flags: Record<string, string | boolean>) {
    return { command: "upgrade", positionals: [], flags };
}

function verbs(): string[] {
    return spawnCalls.map((args) =>
        args.slice(args.indexOf("--project-name") + 2).join(" "),
    );
}

describe("eudiplo upgrade", () => {
    beforeEach(() => {
        spawnCalls.length = 0;
        exitCodes = {};
    });

    it("previews, rewrites only the tags, pulls and recreates", async () => {
        const { config, context, output, envPath } = await setup();

        expect(
            await runUpgradeCommand(
                config,
                parsed({ "image-tag": "8.1.0", yes: true }),
                context,
            ),
        ).toBe(0);

        expect(output.stdout).toContain(
            "ghcr.io/eudiplo/eudiplo: 8.0.2 -> 8.1.0",
        );
        expect(await readFile(envPath, "utf8")).toBe(
            envContent.replaceAll(":8.0.2", ":8.1.0"),
        );
        expect(verbs()).toEqual(["pull", "up -d"]);
        expect(output.stdout).toContain("Upgraded local to 8.1.0.");
    });

    it("moves an instance off the legacy OpenWallet Foundation images", async () => {
        const { config, context, output, envPath } = await setup();
        await writeFile(
            envPath,
            envContent.replaceAll(
                "ghcr.io/eudiplo/",
                "ghcr.io/openwallet-foundation/",
            ),
            "utf8",
        );

        expect(
            await runUpgradeCommand(
                config,
                parsed({ "image-tag": "8.1.0", yes: true }),
                context,
            ),
        ).toBe(0);

        expect(output.stdout).toContain(
            "ghcr.io/openwallet-foundation/eudiplo:8.0.2 -> ghcr.io/eudiplo/eudiplo:8.1.0",
        );
        expect(await readFile(envPath, "utf8")).toBe(
            envContent.replaceAll(":8.0.2", ":8.1.0"),
        );
    });

    it("keeps the env file owner-only", async () => {
        const { config, context, envPath } = await setup();

        await runUpgradeCommand(
            config,
            parsed({ "image-tag": "8.1.0", yes: true }),
            context,
        );

        if (process.platform !== "win32") {
            expect((await stat(envPath)).mode & 0o777).toBe(0o600);
        }
    });

    it("shows migration guides when crossing a major version", async () => {
        const { config, context, output } = await setup();

        await runUpgradeCommand(
            config,
            parsed({ "image-tag": "9.0.0", yes: true }),
            context,
        );

        expect(output.stdout).toContain(
            "https://docs.eudiplo.dev/upgrade/8.x-to-9.0",
        );
    });

    it("restores the previous tags when pulling fails", async () => {
        const { config, context, output, envPath } = await setup();
        exitCodes = { pull: 1 };

        expect(
            await runUpgradeCommand(
                config,
                parsed({ "image-tag": "8.1.0", yes: true }),
                context,
            ),
        ).toBe(1);

        expect(await readFile(envPath, "utf8")).toBe(envContent);
        expect(verbs()).toEqual(["pull"]);
        expect(output.stderr).toContain("Restored the previous image tags");
    });

    it("requires --yes when not interactive and changes nothing", async () => {
        const { config, context, envPath } = await setup({
            interactive: false,
        });

        await expect(
            runUpgradeCommand(
                config,
                parsed({ "image-tag": "8.1.0" }),
                context,
            ),
        ).rejects.toThrow("upgrade requires --yes in non-interactive mode.");

        expect(await readFile(envPath, "utf8")).toBe(envContent);
        expect(spawnCalls).toHaveLength(0);
    });

    it("asks for confirmation and cancels on no", async () => {
        const { config, context, output, envPath } = await setup({
            interactive: true,
            answer: "n",
        });

        expect(
            await runUpgradeCommand(
                config,
                parsed({ "image-tag": "8.1.0" }),
                context,
            ),
        ).toBe(0);

        expect(output.stdout).toContain(
            "Upgrade cancelled. Nothing was changed.",
        );
        expect(await readFile(envPath, "utf8")).toBe(envContent);
        expect(spawnCalls).toHaveLength(0);
    });

    it("proceeds when the confirmation is yes", async () => {
        const { config, context } = await setup({
            interactive: true,
            answer: "yes",
        });

        await runUpgradeCommand(
            config,
            parsed({ "image-tag": "8.1.0" }),
            context,
        );

        expect(verbs()).toEqual(["pull", "up -d"]);
    });

    it("does nothing when already on the requested tag", async () => {
        const { config, context, output } = await setup();

        await runUpgradeCommand(
            config,
            parsed({ "image-tag": "8.0.2", yes: true }),
            context,
        );

        expect(output.stdout).toContain("local already uses image tag 8.0.2.");
        expect(spawnCalls).toHaveLength(0);
    });

    it("fails clearly for external instances", async () => {
        const { config, context } = await setup({
            instance: { target: "external" },
        });

        await expect(
            runUpgradeCommand(
                config,
                parsed({ "image-tag": "8.1.0", yes: true }),
                context,
            ),
        ).rejects.toThrow(
            "upgrade is not available for externally managed deployments",
        );
    });

    it("refuses read-only instances", async () => {
        const { config, context, envPath } = await setup({
            instance: { readOnly: true },
        });

        await expect(
            runUpgradeCommand(
                config,
                parsed({ "image-tag": "8.1.0", yes: true }),
                context,
            ),
        ).rejects.toThrow(/read-only/);
        expect(await readFile(envPath, "utf8")).toBe(envContent);
    });
});
