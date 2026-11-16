import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type ConfigBundle,
    ConfigBundleCodec,
} from "@eudiplo/config-format/config-bundle.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPortabilityCommand } from "../src/commands/config/portability/action.js";
import { runCli } from "../src/runtime.js";
import type { CliConfig, CommandContext } from "../src/types.js";

const fingerprint = "b".repeat(64);
const config: CliConfig = {
    defaultInstance: "test",
    instances: { test: { target: "external", url: "https://example.test" } },
};
const plan = {
    applicable: true,
    planFingerprint: fingerprint,
    items: [
        {
            kind: "Client",
            id: "portal",
            action: "update",
            changes: [{ path: "/spec/description", before: "a", after: "b" }],
        },
    ],
    issues: [],
    assets: [{ path: "images/logo.png", action: "create" }],
};

describe("config plan / import with a tenant folder", () => {
    let cwd: string;
    let tenant: string;
    let output: { stdout: string; stderr: string };
    let context: CommandContext;

    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), "config-folder-plan-"));
        tenant = join(cwd, "acme");
        output = { stdout: "", stderr: "" };
        context = {
            cwd,
            env: {
                EUDIPLO_TOKEN: "test-token",
                PORTAL_SECRET: "s3cr3t-value",
            },
            stdout: {
                write: (chunk: string) => {
                    output.stdout += chunk;
                    return true;
                },
            },
            stderr: {
                write: (chunk: string) => {
                    output.stderr += chunk;
                    return true;
                },
            },
            fetch: vi.fn(
                async () => new Response(JSON.stringify(plan), { status: 200 }),
            ),
        };
        await writeJson(join(tenant, "info.json"), { name: "Acme" });
        // A bare file without envelope, as written by hand or by older exports.
        await writeJson(join(tenant, "clients", "portal.json"), {
            clientId: "portal",
            secret: "${PORTAL_SECRET}",
            roles: ["issuance:manage"],
        });
        await mkdir(join(tenant, "images"));
        await writeFile(join(tenant, "images", "logo.png"), "png-bytes");
        await writeFile(join(tenant, "images", ".gitkeep"), "");
    });

    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
    });

    it("packs the folder into a ZIP bundle and plans it", async () => {
        const code = await runPortabilityCommand(
            "plan",
            config,
            { positionals: ["acme"], flags: {} },
            context,
        );

        expect(code).toBe(0);
        const [url, init] = vi.mocked(context.fetch).mock.calls[0];
        expect(url).toBe(
            "https://example.test/api/config-bundles/plan/archive?mode=upsert",
        );
        const bundle = await sentBundle(init);
        expect(bundle.manifest.tenant).toBe("acme");
        expect(
            bundle.manifest.resources.map((r) => `${r.kind}:${r.id}:${r.path}`),
        ).toEqual([
            "Tenant:tenant:info.json",
            "Client:portal:clients/portal.json",
        ]);
        expect(bundle.documents[1].spec).toMatchObject({
            clientId: "portal",
            secret: "s3cr3t-value",
        });
        expect(bundle.assets.map((asset) => asset.path)).toEqual([
            "images/logo.png",
        ]);
        expect(bundle.assets[0].contentType).toBe("image/png");
        // JSON stays the default plan output.
        expect(JSON.parse(output.stdout).planFingerprint).toBe(fingerprint);
    });

    it("sends the same bundle to plan and import, so the fingerprint matches", async () => {
        await runPortabilityCommand(
            "plan",
            config,
            { positionals: ["acme"], flags: { output: "plan.json" } },
            context,
        );
        await runPortabilityCommand(
            "import",
            config,
            { positionals: ["acme"], flags: { plan: "plan.json" } },
            context,
        );

        const calls = vi.mocked(context.fetch).mock.calls;
        expect(calls[1][0]).toBe(
            `https://example.test/api/config-bundles/import/archive?mode=upsert&planFingerprint=${fingerprint}`,
        );
        expect(await sentZip(calls[1][1])).toEqual(await sentZip(calls[0][1]));
    });

    it("validates the folder offline and never contacts the server when it is invalid", async () => {
        await writeJson(join(tenant, "clients", "broken.json"), {
            clientId: "broken",
            roles: "not-a-list",
        });

        const code = await runPortabilityCommand(
            "plan",
            config,
            { positionals: ["acme"], flags: { format: "text" } },
            context,
        );

        expect(code).toBe(1);
        expect(context.fetch).not.toHaveBeenCalled();
        expect(output.stderr).toContain("FAIL acme");
        expect(output.stderr).toContain("clients/broken.json");
        expect(output.stderr).toContain(
            "Not sent to https://example.test: fix the configuration folder first.",
        );
    });

    it("keeps an unresolved placeholder for the server and names it, without a value", async () => {
        delete context.env.PORTAL_SECRET;

        const code = await runPortabilityCommand(
            "plan",
            config,
            { positionals: ["acme"], flags: {} },
            context,
        );

        // An exported folder keeps its placeholders; the server's plan blocks
        // that resource with SECRET_REQUIRED, so the CLI does not stop here.
        expect(code).toBe(0);
        expect(output.stderr).toContain(
            "clients/portal.json /secret: Unresolved placeholder ${PORTAL_SECRET}",
        );
        expect(output.stderr).toContain("SECRET_REQUIRED");
        const bundle = await sentBundle(
            vi.mocked(context.fetch).mock.calls[0][1],
        );
        expect(bundle.documents[1].spec).toMatchObject({
            secret: "${PORTAL_SECRET}",
        });
    });

    it("writes the validation report as JSON with --format json", async () => {
        await rm(join(tenant, "info.json"));

        const code = await runPortabilityCommand(
            "plan",
            config,
            { positionals: ["acme"], flags: { format: "json" } },
            context,
        );

        expect(code).toBe(1);
        expect(context.fetch).not.toHaveBeenCalled();
        const report = JSON.parse(output.stdout);
        expect(report.valid).toBe(false);
        expect(report.tenants[0].errors[0].file).toBe("info.json");
    });

    it("renders a readable plan with --format text and keeps --diff as its alias", async () => {
        for (const flags of [{ format: "text" }, { diff: true }]) {
            output.stdout = "";
            await runPortabilityCommand(
                "plan",
                config,
                { positionals: ["acme"], flags },
                context,
            );
            expect(output.stdout).toContain("Client/portal: update");
            expect(output.stdout).toContain('  /spec/description: "a" -> "b"');
            expect(output.stdout).toContain("images/logo.png: create");
            expect(output.stdout).toContain(`Plan fingerprint: ${fingerprint}`);
        }
    });

    it("refuses --diff together with --format json", async () => {
        await expect(
            runPortabilityCommand(
                "plan",
                config,
                {
                    positionals: ["acme"],
                    flags: { diff: true, format: "json" },
                },
                context,
            ),
        ).rejects.toThrow("either --diff or --format json");
        expect(context.fetch).not.toHaveBeenCalled();
    });

    it("rejects an unknown --format through the command line", async () => {
        const code = await runCli(
            ["config", "plan", "acme", "--format", "yaml"],
            context,
        );

        expect(code).not.toBe(0);
        expect(output.stderr).toContain("yaml");
        expect(context.fetch).not.toHaveBeenCalled();
    });

    it("fails clearly when the bundle or folder does not exist", async () => {
        await expect(
            runPortabilityCommand(
                "plan",
                config,
                { positionals: ["missing"], flags: {} },
                context,
            ),
        ).rejects.toThrow("Bundle or folder not found");
    });
});

async function writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function sentZip(init: RequestInit | undefined): Promise<Buffer> {
    const file = (init?.body as FormData).get("bundle") as Blob;
    return Buffer.from(await file.arrayBuffer());
}

async function sentBundle(
    init: RequestInit | undefined,
): Promise<ConfigBundle> {
    return new ConfigBundleCodec().decode(await sentZip(init));
}
