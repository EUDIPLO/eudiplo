import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPortabilityCommand } from "../src/commands/config/portability/action.js";
import type { CliConfig, CommandContext } from "../src/types.js";

const fingerprint = "c".repeat(64);
const config: CliConfig = {
    defaultInstance: "test",
    instances: { test: { target: "external", url: "https://example.test" } },
};
const operationId = "6f1c2d3e-0000-4000-8000-000000000001";

/** What the server answers when a step of an import throws (CONFIG_APPLY_FAILED). */
const applyFailure = {
    statusCode: 500,
    code: "CONFIG_APPLY_FAILED",
    operationId,
    failedOperation: { stage: "resource", kind: "KeyChain", id: "signing" },
    message:
        "Configuration apply stopped. Completed operations remain applied; the failed operation may have partial effects. Inspect the report and run plan again before retrying.",
    tenantId: "acme",
    mode: "replace",
    operations: [
        { stage: "asset", path: "images/logo.png", status: "completed" },
        {
            stage: "resource",
            kind: "Client",
            id: "portal",
            status: "completed",
        },
        {
            stage: "ownership",
            kind: "Client",
            id: "portal",
            status: "completed",
        },
        {
            stage: "resource",
            kind: "KeyChain",
            id: "signing",
            status: "failed",
        },
        {
            stage: "ownership",
            kind: "KeyChain",
            id: "signing",
            status: "pending",
        },
        {
            stage: "resource-and-ownership",
            kind: "TrustList",
            id: "eu",
            status: "pending",
        },
        { stage: "delete", kind: "Client", id: "legacy", status: "pending" },
        {
            stage: "delete-ownership",
            kind: "Client",
            id: "legacy",
            status: "pending",
        },
    ],
    generatedSecrets: [
        {
            kind: "Client",
            id: "portal",
            path: "/spec/secret",
            value: "generated-once",
        },
    ],
};

describe("config plan / import outcomes", () => {
    let cwd: string;
    let output: { stdout: string; stderr: string };
    let context: CommandContext;

    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), "config-import-outcomes-"));
        output = { stdout: "", stderr: "" };
        context = {
            cwd,
            env: { EUDIPLO_TOKEN: "test-token", PORTAL_SECRET: "s3cr3t-value" },
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
            fetch: vi.fn(),
        };
        await writeFile(join(cwd, "bundle.json"), "{}");
    });

    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
    });

    const respond = (body: unknown, status = 200) =>
        vi
            .mocked(context.fetch)
            .mockResolvedValue(new Response(JSON.stringify(body), { status }));
    const run = (
        action: "plan" | "import",
        flags: Record<string, string | boolean>,
        positional = "bundle.json",
    ) =>
        runPortabilityCommand(
            action,
            config,
            { positionals: [positional], flags },
            context,
        );

    it("shows a no-op plan as unchanged and applicable", async () => {
        respond({
            applicable: true,
            planFingerprint: fingerprint,
            items: [
                { kind: "Client", id: "portal", action: "unchanged" },
                { kind: "TrustList", id: "eu", action: "unchanged" },
            ],
            assets: [{ path: "images/logo.png", action: "unchanged" }],
        });

        expect(await run("plan", { format: "text" })).toBe(0);
        expect(output.stdout).toBe(
            [
                "Client/portal: unchanged",
                "TrustList/eu: unchanged",
                "images/logo.png: unchanged",
                `Plan fingerprint: ${fingerprint}`,
                "Applicable: yes",
                "",
            ].join("\n"),
        );
        expect(output.stderr).toBe("");
    });

    it("lists created and updated resources with their field changes", async () => {
        respond({
            applicable: true,
            planFingerprint: fingerprint,
            items: [
                {
                    kind: "Client",
                    id: "portal",
                    action: "create",
                    changes: [
                        { path: "/spec/roles", after: ["issuance:manage"] },
                    ],
                },
                {
                    kind: "TrustList",
                    id: "eu",
                    action: "update",
                    changes: [
                        {
                            path: "/spec/description",
                            before: "old",
                            after: "new",
                        },
                    ],
                },
            ],
            assets: [],
        });

        expect(await run("plan", { format: "text" })).toBe(0);
        expect(output.stdout).toContain(
            'Client/portal: create\n  /spec/roles: (absent) -> ["issuance:manage"]\n',
        );
        expect(output.stdout).toContain(
            'TrustList/eu: update\n  /spec/description: "old" -> "new"\n',
        );
    });

    it("blocks a protected deletion in replace mode and sends the confirmation on import", async () => {
        respond({
            applicable: false,
            planFingerprint: fingerprint,
            items: [
                {
                    kind: "Client",
                    id: "legacy",
                    action: "delete",
                    issues: [
                        {
                            code: "CONFIRM_REPLACE_REQUIRED",
                            path: "",
                            message:
                                "Replace mode deletes this resource; confirm with confirmReplace",
                        },
                    ],
                },
            ],
            assets: [],
        });

        expect(await run("plan", { format: "text", mode: "replace" })).toBe(1);
        expect(output.stdout).toContain("Client/legacy: delete\n");
        expect(output.stdout).toContain("Applicable: no\n");
        expect(output.stderr).toContain(
            "Client/legacy: Replace mode deletes this resource",
        );
        expect(vi.mocked(context.fetch).mock.calls[0][0]).toBe(
            "https://example.test/api/config-bundles/plan?mode=replace",
        );

        respond({ applicable: true, operationId, items: [], assets: [] });
        expect(
            await run("import", {
                mode: "replace",
                "confirm-replace": true,
                "plan-fingerprint": fingerprint,
            }),
        ).toBe(0);
        expect(vi.mocked(context.fetch).mock.calls[1][0]).toBe(
            `https://example.test/api/config-bundles/import?mode=replace&planFingerprint=${fingerprint}&confirmReplace=true`,
        );
    });

    it("reports a partial failure per resource, points to the operation report and exits 1", async () => {
        respond(applyFailure, 500);

        const code = await run("import", { "plan-fingerprint": fingerprint });

        expect(code).toBe(1);
        expect(output.stderr).toBe(
            [
                "Import stopped at resource KeyChain/signing: 2 completed, 1 failed, 2 not started.",
                "  completed images/logo.png",
                "  completed Client/portal",
                "  failed    KeyChain/signing",
                "  pending   TrustList/eu",
                "  pending   Client/legacy (delete)",
                "Completed resources stay applied; the failed one may have partial effects.",
                "1 client secret(s) were generated before the failure and are shown only once: see generatedSecrets in the output.",
                `Inspect the report with: eudiplo config operations ${operationId}`,
                "Then run plan again before retrying.",
                "",
            ].join("\n"),
        );
        // The server's report stays machine-readable on stdout, secrets included.
        const report = JSON.parse(output.stdout);
        expect(report.operationId).toBe(operationId);
        expect(report.operations).toHaveLength(8);
        expect(report.generatedSecrets[0].value).toBe("generated-once");
    });

    it("keeps reporting other import errors as before", async () => {
        vi.mocked(context.fetch).mockResolvedValue(
            new Response(
                JSON.stringify({
                    statusCode: 409,
                    code: "CONFIG_PLAN_STALE",
                    message: "The configuration changed since the plan",
                }),
                { status: 409 },
            ),
        );

        await expect(
            run("import", { "plan-fingerprint": fingerprint }),
        ).rejects.toThrow(
            "EUDIPLO API returned 409: " +
                '{"statusCode":409,"code":"CONFIG_PLAN_STALE","message":"The configuration changed since the plan"}',
        );
        expect(output.stdout).toBe("");
    });

    it("does not treat a non-JSON server error as a partial failure", async () => {
        vi.mocked(context.fetch).mockResolvedValue(
            new Response("Bad gateway", { status: 502 }),
        );

        await expect(
            run("import", { "plan-fingerprint": fingerprint }),
        ).rejects.toThrow("EUDIPLO API returned 502: Bad gateway");
    });

    it("shows a filled-in folder value as its placeholder in the failure report", async () => {
        const tenant = join(cwd, "acme");
        await mkdir(join(tenant, "clients"), { recursive: true });
        await writeFile(
            join(tenant, "info.json"),
            JSON.stringify({ name: "Acme" }),
        );
        await writeFile(
            join(tenant, "clients", "portal.json"),
            JSON.stringify({
                clientId: "portal",
                secret: "${PORTAL_SECRET}",
                roles: ["issuance:manage"],
            }),
        );
        respond(
            {
                ...applyFailure,
                message: "secret s3cr3t-value was rejected by the store",
            },
            500,
        );

        const code = await run(
            "import",
            { "plan-fingerprint": fingerprint, "allow-env": "PORTAL_SECRET" },
            "acme",
        );

        expect(code).toBe(1);
        expect(output.stdout).not.toContain("s3cr3t-value");
        expect(JSON.parse(output.stdout).message).toBe(
            "secret ${PORTAL_SECRET} was rejected by the store",
        );
    });
});
