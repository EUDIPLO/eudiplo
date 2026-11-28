import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
    CommandContext,
    DriverCommandOptions,
    InstanceConfig,
} from "../src/types.js";

interface SpawnCall {
    command: string;
    args: string[];
}

const spawnCalls: SpawnCall[] = [];
let servicesOutput = "eudiplo\neudiplo-client\n";

// Replace process spawning so no real container runtime is ever invoked,
// even on machines or CI runners where Docker or Podman is installed.
vi.mock("node:child_process", () => ({
    spawn: vi.fn((command: string, args: string[]) => {
        spawnCalls.push({ command, args });
        const child = new EventEmitter() as EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
        };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setImmediate(() => {
            if (args.includes("config") && args.includes("--services")) {
                child.stdout.emit("data", servicesOutput);
            }
            child.emit("close", 0);
        });
        return child;
    }),
}));

const { drivers } = await import("../src/services/deployment-drivers.js");

async function createOptions(
    runtime: "docker" | "podman",
    flags: Record<string, string | boolean> = {},
    instanceOverrides: Partial<InstanceConfig> = {},
) {
    const cwd = await mkdtemp(join(tmpdir(), "eudiplo-compose-"));
    const bin = join(cwd, "bin");
    await mkdir(bin);
    // resolveComposeRuntime only checks that an executable exists; spawn is
    // mocked, so the script never runs.
    const executable = join(
        bin,
        process.platform === "win32" ? `${runtime}.exe` : runtime,
    );
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o700);

    const output = { stdout: "", stderr: "" };
    const context: CommandContext = {
        cwd,
        installationMethod: "npm",
        env: { EUDIPLO_CONTAINER_RUNTIME: runtime, PATH: bin },
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
    const options: DriverCommandOptions = {
        instanceName: "local",
        instance: {
            target: "compose",
            url: "http://localhost:3000",
            projectDirectory: cwd,
            projectName: "eudiplo-local",
            ...instanceOverrides,
        },
        args: [],
        flags,
        context,
    };
    return { options, output };
}

// The subcommand portion of a compose invocation, after the shared options.
function subcommand(call: SpawnCall): string[] {
    const index = call.args.indexOf("--project-name");
    return call.args.slice(index + 2);
}

describe.each(["docker", "podman"] as const)(
    "compose lifecycle on %s",
    (runtime) => {
        beforeEach(() => {
            spawnCalls.length = 0;
            servicesOutput = "eudiplo\neudiplo-client\n";
        });

        it("runs ps through the selected runtime", async () => {
            const { options } = await createOptions(runtime);

            expect(await drivers.compose.ps?.(options)).toBe(0);

            expect(spawnCalls).toHaveLength(1);
            expect(basename(spawnCalls[0].command)).toMatch(
                new RegExp(`^${runtime}`),
            );
            expect(spawnCalls[0].args[0]).toBe("compose");
            expect(subcommand(spawnCalls[0])).toEqual(["ps"]);
        });

        it("maps log flags and validates the service against the project", async () => {
            const { options } = await createOptions(runtime, {
                service: "eudiplo",
                follow: true,
                tail: "50",
                since: "15m",
            });

            expect(await drivers.compose.logs?.(options)).toBe(0);

            expect(spawnCalls.map(subcommand)).toEqual([
                ["config", "--services"],
                [
                    "logs",
                    "--follow",
                    "--tail",
                    "50",
                    "--since",
                    "15m",
                    "eudiplo",
                ],
            ]);
        });

        it("does not follow logs by default", async () => {
            const { options } = await createOptions(runtime);

            expect(await drivers.compose.logs?.(options)).toBe(0);

            expect(spawnCalls.map(subcommand)).toEqual([["logs"]]);
        });

        it("rejects a service the project does not define", async () => {
            const { options } = await createOptions(runtime, {
                service: "backend",
            });

            await expect(drivers.compose.logs?.(options)).rejects.toThrow(
                "Unknown service backend. Services in this project: eudiplo, eudiplo-client.",
            );
            expect(spawnCalls.map(subcommand)).toEqual([
                ["config", "--services"],
            ]);
        });

        it("rejects flag-like service names before running anything", async () => {
            const { options } = await createOptions(runtime, {
                service: "--rm",
            });

            await expect(drivers.compose.restart?.(options)).rejects.toThrow(
                /Invalid service name/,
            );
            expect(spawnCalls).toHaveLength(0);
        });

        it("rejects an invalid --since before running anything", async () => {
            const { options } = await createOptions(runtime, {
                since: "yesterday",
            });

            await expect(drivers.compose.logs?.(options)).rejects.toThrow(
                /Invalid --since/,
            );
            expect(spawnCalls).toHaveLength(0);
        });

        it("announces the target and runtime before restarting", async () => {
            const { options, output } = await createOptions(runtime, {
                service: "eudiplo-client",
            });

            expect(await drivers.compose.restart?.(options)).toBe(0);

            expect(output.stdout).toContain(
                `Restarting eudiplo-client of local with ${runtime} compose`,
            );
            expect(spawnCalls.map(subcommand).at(-1)).toEqual([
                "restart",
                "eudiplo-client",
            ]);
        });

        it("restarts every service when none is named", async () => {
            const { options, output } = await createOptions(runtime);

            expect(await drivers.compose.restart?.(options)).toBe(0);

            expect(output.stdout).toContain("Restarting all services of local");
            expect(spawnCalls.map(subcommand)).toEqual([["restart"]]);
        });

        it("pulls every image or one validated service", async () => {
            const { options } = await createOptions(runtime);
            expect(await drivers.compose.pull?.(options)).toBe(0);

            const single = await createOptions(runtime, { service: "eudiplo" });
            expect(await drivers.compose.pull?.(single.options)).toBe(0);

            expect(spawnCalls.map(subcommand)).toEqual([
                ["pull"],
                ["config", "--services"],
                ["pull", "eudiplo"],
            ]);
        });

        it("refuses to restart read-only instances", async () => {
            const { options } = await createOptions(
                runtime,
                {},
                { readOnly: true },
            );

            await expect(drivers.compose.restart?.(options)).rejects.toThrow(
                /read-only/,
            );
            expect(spawnCalls).toHaveLength(0);
        });
    },
);
