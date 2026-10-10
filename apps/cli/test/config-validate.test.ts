import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/runtime.js";
import type { CommandContext } from "../src/types.js";

describe("eudiplo config validate tenant(s)", () => {
    it("validates a configured tenant through the tenant command", async () => {
        const { context, output, cwd } = await createContext();
        await writeTenantInfo(join(cwd, "root"), { name: "Root Tenant" });

        const code = await runCli(
            ["config", "tenant", "validate", "root", "--config-directory", cwd],
            context,
        );

        expect(code).toBe(0);
        expect(output.stdout).toContain("PASS root");
    });

    it("validates all configured tenants when no tenant ID is given", async () => {
        const { context, output, cwd } = await createContext();
        await writeTenantInfo(join(cwd, "root"), { name: "Root Tenant" });
        await mkdir(join(cwd, "partner-a"), { recursive: true });

        const code = await runCli(
            ["config", "tenant", "validate", "--config-directory", cwd],
            context,
        );

        expect(code).toBe(1);
        expect(output.stdout).toContain("PASS root");
        expect(output.stdout).toContain("FAIL partner-a");
    });

    it("reports usage when no path is given", async () => {
        const { context, output } = await createContext();

        const code = await runCli(["config", "validate", "tenant"], context);

        expect(code).toBe(1);
        expect(output.stderr).toContain(
            "Usage: eudiplo config validate tenant <path>",
        );
    });

    it("passes for a valid tenant directory and reports resource counts", async () => {
        const { context, output, cwd } = await createContext();
        const tenantDir = join(cwd, "root");
        await writeTenantInfo(tenantDir, { name: "Root Tenant" });
        await writeResource(tenantDir, "clients", "root.json", {
            clientId: "root",
            roles: ["issuance:manage"],
        });

        const code = await runCli(
            ["config", "validate", "tenant", tenantDir],
            context,
        );

        expect(code).toBe(0);
        expect(output.stdout).toContain("PASS root");
        expect(output.stdout).toContain("1 client config");
        expect(output.stdout).toContain("No errors found.");
    });

    it("validates versioned demo files through compatibility file schemas", async () => {
        const { context, output, cwd } = await createContext();

        const createCode = await runCli(
            [
                "config",
                "tenant",
                "create",
                "demo",
                "--config-directory",
                cwd,
                "--template",
                "demo",
                "--name",
                "Demo Tenant",
            ],
            context,
        );
        expect(createCode).toBe(0);

        output.stdout = "";
        const validateCode = await runCli(
            ["config", "validate", "tenant", join(cwd, "demo")],
            context,
        );

        expect(validateCode).toBe(0);
        expect(output.stdout).toContain("PASS demo");
        expect(output.stdout).toContain("4 key-chain");
        expect(output.stdout).toContain("1 issuance config");
        expect(output.stdout).toContain("2 presentation configs");
    });

    it("validates the canonical HAIP fixture envelopes", async () => {
        const { context, output } = await createContext();
        const haipDirectory = resolve(
            __dirname,
            "../../backend/test/fixtures/haip",
        );

        const code = await runCli(
            ["config", "validate", "tenant", haipDirectory],
            context,
        );

        expect(code).toBe(0);
        expect(output.stdout).toContain("PASS haip");
        expect(output.stdout).toContain("25 configuration file(s)");
        expect(output.stdout).toContain("1 attribute provider");
    });

    it("does not require optional registrar or tenant KMS config files", async () => {
        const { context, output, cwd } = await createContext();
        const tenantDir = join(cwd, "root");
        await writeTenantInfo(tenantDir, { name: "Root Tenant" });

        const code = await runCli(
            ["config", "validate", "tenant", tenantDir],
            context,
        );

        expect(code).toBe(0);
        expect(output.stdout).toContain("PASS root");
    });

    it("validates the optional registrar config file when present", async () => {
        const { context, output, cwd } = await createContext();
        const tenantDir = join(cwd, "root");
        await writeTenantInfo(tenantDir, { name: "Root Tenant" });
        await writeFile(
            join(tenantDir, "registrar.json"),
            JSON.stringify({}),
            "utf8",
        );

        const code = await runCli(
            ["config", "validate", "tenant", tenantDir],
            context,
        );

        expect(code).toBe(1);
        expect(output.stdout).toContain("registrar.json");
    });

    it("ignores unknown directories that the backend does not import", async () => {
        const { context, output, cwd } = await createContext();
        const tenantDir = join(cwd, "root");
        await writeTenantInfo(tenantDir, { name: "Root Tenant" });
        await mkdir(join(tenantDir, "unsupported"), { recursive: true });
        await writeFile(
            join(tenantDir, "unsupported", "broken.json"),
            "{ not json",
            "utf8",
        );

        const code = await runCli(
            ["config", "validate", "tenant", tenantDir],
            context,
        );

        expect(code).toBe(0);
        expect(output.stdout).not.toContain("unsupported/broken.json");
    });

    it("fails when info.json is missing", async () => {
        const { context, output, cwd } = await createContext();
        const tenantDir = join(cwd, "root");
        await mkdir(tenantDir, { recursive: true });

        const code = await runCli(
            ["config", "validate", "tenant", tenantDir],
            context,
        );

        expect(code).toBe(1);
        expect(output.stdout).toContain("FAIL root");
        expect(output.stdout).toContain(
            "Missing required tenant metadata file",
        );
    });

    it("collects schema errors with file and readable path", async () => {
        const { context, output, cwd } = await createContext();
        const tenantDir = join(cwd, "root");
        await writeTenantInfo(tenantDir, { name: "Root Tenant" });
        await writeResource(tenantDir, "clients", "broken.json", {
            clientId: "broken",
            // roles is required and missing
        });

        const code = await runCli(
            ["config", "validate", "tenant", tenantDir],
            context,
        );

        expect(code).toBe(1);
        expect(output.stdout).toContain("FAIL root");
        expect(output.stdout).toContain("clients/broken.json");
        expect(output.stdout).toContain("roles");
    });

    it("reports invalid JSON with the tenant and filename", async () => {
        const { context, output, cwd } = await createContext();
        const tenantDir = join(cwd, "root");
        await writeTenantInfo(tenantDir, { name: "Root Tenant" });
        await mkdir(join(tenantDir, "clients"), { recursive: true });
        await writeFile(
            join(tenantDir, "clients", "invalid.json"),
            "{ not json",
            "utf8",
        );

        const code = await runCli(
            ["config", "validate", "tenant", tenantDir],
            context,
        );

        expect(code).toBe(1);
        expect(output.stdout).toContain("clients/invalid.json");
        expect(output.stdout).toContain("Invalid JSON");
    });

    it("detects unresolved required placeholders without printing secret values", async () => {
        const { context, output, cwd } = await createContext();
        const tenantDir = join(cwd, "root");
        await writeTenantInfo(tenantDir, { name: "Root Tenant" });
        await writeResource(tenantDir, "clients", "root.json", {
            clientId: "root",
            secret: "${ROOT_CLIENT_SECRET}",
            roles: ["issuance:manage"],
        });

        const code = await runCli(
            ["config", "validate", "tenant", tenantDir],
            context,
        );

        expect(code).toBe(1);
        expect(output.stdout).toContain(
            "Unresolved placeholder ${ROOT_CLIENT_SECRET}",
        );
    });

    it("resolves placeholders from the environment for validation", async () => {
        const { context, output, cwd } = await createContext();
        context.env.ROOT_CLIENT_SECRET = "super-secret-value";
        const tenantDir = join(cwd, "root");
        await writeTenantInfo(tenantDir, { name: "Root Tenant" });
        await writeResource(tenantDir, "clients", "root.json", {
            clientId: "root",
            secret: "${ROOT_CLIENT_SECRET}",
            roles: ["issuance:manage"],
        });

        const code = await runCli(
            ["config", "validate", "tenant", tenantDir],
            context,
        );

        expect(code).toBe(0);
        expect(output.stdout).not.toContain("super-secret-value");
    });

    it("validates every tenant under a configuration root and collects errors", async () => {
        const { context, output, cwd } = await createContext();
        await writeTenantInfo(join(cwd, "root"), { name: "Root Tenant" });
        await writeResource(join(cwd, "root"), "clients", "root.json", {
            clientId: "root",
            roles: ["issuance:manage"],
        });
        await mkdir(join(cwd, "partner-a"), { recursive: true });

        const code = await runCli(
            ["config", "validate", "tenants", cwd],
            context,
        );

        expect(code).toBe(1);
        expect(output.stdout).toContain("PASS root");
        expect(output.stdout).toContain("FAIL partner-a");
        expect(output.stdout).toMatch(
            /Validation failed: \d+ error\(s\) in 1 tenant\(s\)\./,
        );
    });

    it("supports a machine-readable json report", async () => {
        const { context, output, cwd } = await createContext();
        await mkdir(join(cwd, "root"), { recursive: true });

        const code = await runCli(
            ["config", "validate", "tenants", cwd, "--format", "json"],
            context,
        );

        expect(code).toBe(1);
        const report = JSON.parse(output.stdout);
        expect(report.valid).toBe(false);
        expect(report.summary.tenants).toBe(1);
        expect(report.tenants[0].id).toBe("root");
        expect(report.tenants[0].errors[0]).toMatchObject({
            file: "info.json",
            message: expect.stringContaining("Missing required"),
        });
    });

    it("fails with a clear error when the configuration root does not exist", async () => {
        const { context, output, cwd } = await createContext();

        const code = await runCli(
            ["config", "validate", "tenants", join(cwd, "missing")],
            context,
        );

        expect(code).toBe(1);
        expect(output.stderr).toContain("Configuration root not found");
    });
});

async function writeTenantInfo(
    tenantDir: string,
    payload: unknown,
): Promise<void> {
    await mkdir(tenantDir, { recursive: true });
    await writeFile(
        join(tenantDir, "info.json"),
        JSON.stringify(payload, null, 2),
        "utf8",
    );
}

async function writeResource(
    tenantDir: string,
    subfolder: string,
    fileName: string,
    payload: unknown,
): Promise<void> {
    const directory = join(tenantDir, subfolder);
    await mkdir(directory, { recursive: true });
    await writeFile(
        join(directory, fileName),
        JSON.stringify(payload, null, 2),
        "utf8",
    );
}

async function createContext(): Promise<{
    context: CommandContext;
    output: { stdout: string; stderr: string };
    cwd: string;
}> {
    const cwd = await mkdtemp(join(tmpdir(), "eudiplo-cli-config-validate-"));
    const output = { stdout: "", stderr: "" };
    const context: CommandContext = {
        cwd,
        env: {
            PATH: process.env.PATH,
        },
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
