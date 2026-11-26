import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CLOUD_CREDENTIAL_VARIABLES } from "../src/commands/config/validate/validator.js";
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

    it("does not require an optional tenant KMS config file", async () => {
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

    it("warns about a registrar config file, which is no longer imported", async () => {
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

        expect(code).toBe(0);
        expect(output.stdout).toContain("PASS root");
        expect(output.stdout).toContain(
            "warning registrar.json: registrar.json is skipped",
        );
    });

    it.each([
        [{ access: "registrar-access" }, 0],
        [{ access: "" }, 1],
        [{ signing: "sign" }, 1],
    ])(
        "validates the optional key chain defaults file %j",
        async (spec, expected) => {
            const { context, output, cwd } = await createContext();
            const tenantDir = join(cwd, "root");
            await writeTenantInfo(tenantDir, { name: "Root Tenant" });
            await writeFile(
                join(tenantDir, "key-chain-defaults.json"),
                JSON.stringify(spec),
                "utf8",
            );

            const code = await runCli(
                ["config", "validate", "tenant", tenantDir],
                context,
            );

            expect(code).toBe(expected);
            if (expected)
                expect(output.stdout).toContain("key-chain-defaults.json");
        },
    );

    it("ignores unknown directories that the backend does not import", async () => {
        const { context, output, cwd } = await createContext();
        const tenantDir = join(cwd, "root");
        await writeTenantInfo(tenantDir, { name: "Root Tenant" });
        await mkdir(join(tenantDir, "unsupported"), { recursive: true });
        await writeFile(
            join(tenantDir, "unsupported", "broken.json"),
            '{"s":"leak" x}',
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

    it("refuses two display entries for one locale in a credential file without $schema", async () => {
        const { context, output, cwd } = await createContext();
        const tenantDir = join(cwd, "root");
        await writeTenantInfo(tenantDir, { name: "Root Tenant" });
        await writeResource(tenantDir, "issuance/credentials", "pid.json", {
            id: "pid",
            config: {
                format: "dc+sd-jwt",
                display: [
                    { name: "PID", locale: "en-US" },
                    { name: "PID", locale: "en-us" },
                ],
            },
            fields: [],
        });

        const code = await runCli(
            ["config", "validate", "tenant", tenantDir],
            context,
        );

        expect(code).toBe(1);
        expect(output.stdout).toContain("issuance/credentials/pid.json");
        expect(output.stdout).toContain(
            "Locale en-us is already used by display entry 1",
        );
    });

    it("explains an unreadable display color in a credential file without $schema", async () => {
        const { context, output, cwd } = await createContext();
        const tenantDir = join(cwd, "root");
        await writeTenantInfo(tenantDir, { name: "Root Tenant" });
        await writeResource(tenantDir, "issuance/credentials", "pid.json", {
            id: "pid",
            config: {
                format: "dc+sd-jwt",
                display: [{ name: "PID", locale: "en-US", text_color: "navy" }],
            },
            fields: [],
        });

        const code = await runCli(
            ["config", "validate", "tenant", tenantDir],
            context,
        );

        expect(code).toBe(1);
        expect(output.stdout).toContain(
            "Use a CSS Color Level 3 numerical value",
        );
        expect(output.stdout).not.toContain("^(?:");
    });

    it("reports invalid JSON with the tenant and filename", async () => {
        const { context, output, cwd } = await createContext();
        const tenantDir = join(cwd, "root");
        await writeTenantInfo(tenantDir, { name: "Root Tenant" });
        await mkdir(join(tenantDir, "clients"), { recursive: true });
        await writeFile(
            join(tenantDir, "clients", "invalid.json"),
            '{"s":"leak" x}',
            "utf8",
        );

        const code = await runCli(
            ["config", "validate", "tenant", tenantDir],
            context,
        );

        expect(code).toBe(1);
        expect(output.stdout).toContain("clients/invalid.json");
        // Only the fixed text: the parser's message would quote the file.
        expect(output.stdout).toMatch(/Invalid JSON\s*$/m);
        expect(output.stdout).not.toContain("leak");
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

    it("reads $${ in a tenant file as text, not as a placeholder", async () => {
        const { context, output, cwd } = await createContext();
        const tenantDir = join(cwd, "root");
        await writeTenantInfo(tenantDir, { name: "Hook $${UNSET}" });

        const code = await runCli(
            ["config", "validate", "tenant", tenantDir],
            context,
        );

        expect(code).toBe(0);
        expect(output.stdout).not.toContain("Unresolved placeholder");
        expect(output.stdout).not.toContain("UNSET");
    });

    it("reads $${ in a kms.json as a $ and a placeholder, which has no escaped form", async () => {
        const { context, output, cwd } = await createContext();
        const tenantDir = join(cwd, "root");
        await writeTenantInfo(tenantDir, { name: "Root Tenant" });
        await writeKms(tenantDir, "$${UNSET}");

        const code = await runCli(
            ["config", "validate", "tenant", tenantDir],
            context,
        );

        expect(code).toBe(1);
        expect(output.stdout).toContain("Unresolved placeholder ${UNSET}");
    });

    it("refuses the cloud credentials of the instance in a tenant file, with the backend's reason", async () => {
        const { context, output, cwd } = await createContext();
        // A value does not make the variable usable, nor does a default.
        context.env.AWS_SECRET_ACCESS_KEY = "instance-credential";
        const tenantDir = join(cwd, "root");
        await writeTenantInfo(tenantDir, { name: "Root Tenant" });
        await writeResource(tenantDir, "clients", "root.json", {
            clientId: "root",
            secret: "${AWS_SECRET_ACCESS_KEY}",
            description: "${AZURE_CLIENT_SECRET:none}",
            roles: ["issuance:manage"],
        });

        const code = await runCli(
            ["config", "validate", "tenant", tenantDir, "--format", "json"],
            context,
        );

        expect(code).toBe(1);
        const [tenant] = JSON.parse(output.stdout).tenants;
        expect(tenant.errors).toEqual([
            {
                file: "clients/root.json",
                message:
                    "${AWS_SECRET_ACCESS_KEY} holds the AWS credentials of the instance, which a file of a tenant folder cannot use",
            },
            {
                file: "clients/root.json",
                message:
                    "${AZURE_CLIENT_SECRET} holds the Azure credentials of the instance, which a file of a tenant folder cannot use",
            },
        ]);
        expect(output.stdout).not.toContain("instance-credential");
    });

    it("reports a refused variable without a value once, not also as unresolved", async () => {
        const { context, output, cwd } = await createContext();
        const tenantDir = join(cwd, "root");
        await writeTenantInfo(tenantDir, { name: "${AWS_SESSION_TOKEN}" });

        const code = await runCli(
            ["config", "validate", "tenant", tenantDir],
            context,
        );

        expect(code).toBe(1);
        expect(output.stdout).toContain(
            "${AWS_SESSION_TOKEN} holds the AWS credentials of the instance",
        );
        expect(output.stdout).not.toContain("Unresolved placeholder");
    });

    it("refuses the cloud credentials the backend refuses, and no others", async () => {
        // The backend's list, read from its source: the CLI keeps a copy.
        const source = await readFile(
            resolve(
                import.meta.dirname,
                "../../backend/src/platform/config/config-variable-scope.ts",
            ),
            "utf8",
        );
        const block =
            /CLOUD_CREDENTIAL_VARIABLES[^=]*=\s*new Map\(\[([\s\S]*?)\]\);/.exec(
                source,
            )?.[1];
        const backend = [
            ...(block ?? "").matchAll(/\["([A-Z0-9_]+)",\s*"([A-Za-z]+)"\]/g),
        ].map(([, name, provider]) => [name, provider]);
        expect(backend.length).toBeGreaterThan(0);
        expect([...CLOUD_CREDENTIAL_VARIABLES]).toEqual(backend);
    });

    it("checks the variables of every tenant under a configuration root", async () => {
        const { context, output, cwd } = await createContext();
        await writeTenantInfo(join(cwd, "root"), { name: "Root Tenant" });
        await writeResource(join(cwd, "root"), "clients", "x.json", {
            clientId: "x",
            secret: "${AWS_ACCESS_KEY_ID}",
            roles: ["issuance:manage"],
        });

        const code = await runCli(
            ["config", "validate", "tenants", cwd, "--format", "json"],
            context,
        );

        expect(code).toBe(1);
        const [tenant] = JSON.parse(output.stdout).tenants;
        expect(tenant.errors[0].message).toContain("holds the AWS credentials");
    });

    it("warns that a tenant kms.json resolves only the variables the instance lists", async () => {
        const { context, output, cwd } = await createContext();
        context.env.SHOP_VAULT_TOKEN = "vault-token-value";
        const tenantDir = join(cwd, "root");
        await writeTenantInfo(tenantDir, { name: "Root Tenant" });
        await writeKms(tenantDir, "${SHOP_VAULT_TOKEN}");

        const code = await runCli(
            ["config", "validate", "tenant", tenantDir],
            context,
        );

        // A warning: the CLI cannot read the instance's KMS_TENANT_VARIABLES.
        expect(code).toBe(0);
        expect(output.stdout).toContain(
            "warning kms.json: ${SHOP_VAULT_TOKEN} is resolved only if the instance lists SHOP_VAULT_TOKEN in KMS_TENANT_VARIABLES",
        );
        expect(output.stdout).not.toContain("vault-token-value");
    });

    it("only warns for the cloud credentials in a tenant kms.json, which the instance can list", async () => {
        const { context, output, cwd } = await createContext();
        context.env.AWS_SECRET_ACCESS_KEY = "instance-credential";
        const tenantDir = join(cwd, "root");
        await writeTenantInfo(tenantDir, { name: "Root Tenant" });
        await writeKms(tenantDir, "${AWS_SECRET_ACCESS_KEY}");

        const code = await runCli(
            ["config", "validate", "tenant", tenantDir],
            context,
        );

        expect(code).toBe(0);
        expect(output.stdout).toContain(
            "warning kms.json: ${AWS_SECRET_ACCESS_KEY} is resolved only if",
        );
        expect(output.stdout).not.toContain("holds the AWS credentials");
    });

    it("does not warn for PUBLIC_URL in a tenant kms.json, which every file can use", async () => {
        const { context, output, cwd } = await createContext();
        context.env.PUBLIC_URL = "https://issuer.example";
        const tenantDir = join(cwd, "root");
        await writeTenantInfo(tenantDir, { name: "Root Tenant" });
        await writeKms(tenantDir, "${PUBLIC_URL}");

        const code = await runCli(
            ["config", "validate", "tenant", tenantDir],
            context,
        );

        expect(code).toBe(0);
        expect(output.stdout).not.toContain("KMS_TENANT_VARIABLES");
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

    it("lists a skipped registrar config file in the json report", async () => {
        const { context, output, cwd } = await createContext();
        const tenantDir = join(cwd, "root");
        await writeTenantInfo(tenantDir, { name: "Root Tenant" });
        await writeFile(join(tenantDir, "registrar.json"), "{}", "utf8");

        const code = await runCli(
            ["config", "validate", "tenant", tenantDir, "--format", "json"],
            context,
        );

        expect(code).toBe(0);
        const report = JSON.parse(output.stdout);
        expect(report.valid).toBe(true);
        expect(report.tenants[0].warnings).toEqual([
            {
                file: "registrar.json",
                message: expect.stringMatching(/^registrar\.json is skipped/),
            },
        ]);
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

async function writeKms(tenantDir: string, vaultToken: string): Promise<void> {
    await writeFile(
        join(tenantDir, "kms.json"),
        JSON.stringify({
            providers: [
                {
                    id: "vault",
                    type: "vault",
                    vaultUrl: "https://vault.example",
                    vaultToken,
                },
            ],
        }),
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
