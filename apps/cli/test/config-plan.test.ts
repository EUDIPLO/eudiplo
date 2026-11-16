import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPortabilityCommand } from "../src/commands/config/portability/action.js";
import type { CliConfig, CommandContext } from "../src/types.js";

const fingerprint = "a".repeat(64);
const config: CliConfig = {
    defaultInstance: "test",
    instances: { test: { target: "external", url: "https://example.test" } },
};
describe("reviewed CLI import plans", () => {
    let cwd: string;
    let context: CommandContext;
    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), "config-plan-"));
        context = {
            cwd,
            env: { EUDIPLO_TOKEN: "test-token" },
            stdout: { write: () => true },
            stderr: { write: () => true },
            fetch: vi.fn(
                async () =>
                    new Response(
                        JSON.stringify({
                            applicable: true,
                            planFingerprint: fingerprint,
                            items: [],
                            assets: [],
                        }),
                        { status: 200 },
                    ),
            ),
        };
        await writeFile(join(cwd, "bundle.json"), "{}");
    });
    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
    });
    it("saves a reviewable plan and submits that fingerprint when importing", async () => {
        await runPortabilityCommand(
            "plan",
            config,
            {
                positionals: ["bundle.json"],
                flags: { output: "plan.json", diff: true },
            },
            context,
        );
        expect(
            JSON.parse(await readFile(join(cwd, "plan.json"), "utf8"))
                .planFingerprint,
        ).toBe(fingerprint);
        await runPortabilityCommand(
            "import",
            config,
            { positionals: ["bundle.json"], flags: { plan: "plan.json" } },
            context,
        );
        expect(vi.mocked(context.fetch).mock.calls[1][0]).toContain(
            `planFingerprint=${fingerprint}`,
        );
    });
    it("sends a .zip bundle unchanged to the archive endpoint", async () => {
        const zip = Buffer.from("PK\u0003\u0004zip-bytes");
        await writeFile(join(cwd, "bundle.zip"), zip);

        await runPortabilityCommand(
            "plan",
            config,
            { positionals: ["bundle.zip"], flags: {} },
            context,
        );

        const [url, init] = vi.mocked(context.fetch).mock.calls[0];
        expect(url).toBe(
            "https://example.test/api/config-bundles/plan/archive?mode=upsert",
        );
        const file = (init?.body as FormData).get("bundle") as File;
        expect(file.name).toBe("bundle.zip");
        expect(Buffer.from(await file.arrayBuffer())).toEqual(zip);
    });
    it("refuses an import without a reviewed plan before contacting the server", async () => {
        await expect(
            runPortabilityCommand(
                "import",
                config,
                { positionals: ["bundle.json"], flags: {} },
                context,
            ),
        ).rejects.toThrow("reviewed plan");
        expect(context.fetch).not.toHaveBeenCalled();
    });
    it("requires an explicit stopped-worker acknowledgment for recovery", async () => {
        await expect(
            runPortabilityCommand(
                "recover",
                config,
                { positionals: ["run-id"], flags: {} },
                context,
            ),
        ).rejects.toThrow("confirm-worker-stopped");
        expect(context.fetch).not.toHaveBeenCalled();
        await runPortabilityCommand(
            "recover",
            config,
            {
                positionals: ["run-id"],
                flags: { "confirm-worker-stopped": true },
            },
            context,
        );
        expect(vi.mocked(context.fetch).mock.calls[0][0]).toContain(
            "/operations/run-id/acknowledge-interruption?confirmWorkerStopped=true",
        );
    });
});
