import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parsedArgs } from "../src/commands/shared.js";
import type { CommandContext, DriverCommandOptions } from "../src/types.js";

const spawnCalls: string[][] = [];

// No real kubectl is ever invoked.
vi.mock("node:child_process", () => ({
    spawn: vi.fn((_command: string, args: string[]) => {
        spawnCalls.push(args);
        const child = new EventEmitter() as EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
        };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setImmediate(() => child.emit("close", 0));
        return child;
    }),
}));

const { drivers } = await import("../src/services/deployment-drivers.js");

async function createOptions(
    commanderOptions: Record<string, unknown>,
): Promise<DriverCommandOptions> {
    const cwd = await mkdtemp(join(tmpdir(), "eudiplo-k8s-"));
    const kubectl = join(cwd, "kubectl");
    await writeFile(kubectl, "", "utf8");
    const context: CommandContext = {
        cwd,
        installationMethod: "npm",
        env: { EUDIPLO_KUBECTL: kubectl },
        stdout: { write: () => true },
        stderr: { write: () => true },
        fetch,
    };
    return {
        instanceName: "production",
        instance: {
            target: "kubernetes",
            url: "https://eudiplo.example.com",
            context: "production",
            namespace: "eudiplo",
            workloads: { backend: "deployment/eudiplo" },
        },
        args: [],
        // Flags exactly as Commander hands them to the driver.
        flags: parsedArgs("restart", undefined, [], commanderOptions).flags,
        context,
    };
}

function verbs(): string[] {
    return spawnCalls.map((args) => args.slice(0, 2).join(" "));
}

describe("kubernetes restart waiting", () => {
    beforeEach(() => {
        spawnCalls.length = 0;
    });

    it("waits for the rollout by default", async () => {
        const options = await createOptions({ wait: true });

        expect(await drivers.kubernetes.restart?.(options)).toBe(0);

        expect(verbs()).toEqual(["rollout restart", "rollout status"]);
    });

    it("skips the rollout wait with --no-wait", async () => {
        // Commander sets wait=false for --no-wait; parsedArgs turns that
        // into a "no-wait" flag.
        const options = await createOptions({ wait: false });

        expect(await drivers.kubernetes.restart?.(options)).toBe(0);

        expect(verbs()).toEqual(["rollout restart"]);
    });
});
