import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/runtime.js";
import {
    drivers,
    resolveComposeRuntime,
} from "../src/services/deployment-drivers.js";
import type { CommandContext } from "../src/types.js";

describe("EUDIPLO CLI", () => {
    it("prints command descriptions in help", async () => {
        const { context, output } = await createContext();

        const code = await runCli([], context);

        expect(code).toBe(0);
        expect(output.stdout).toContain("Commands:");
        expect(output.stdout).toContain("demo [options] [directory]");
        expect(output.stdout).toContain("Start the minimal local demo");
        expect(output.stdout).toContain("config");
        expect(output.stdout).toContain(
            "Validate and manage local configuration",
        );
        expect(output.stdout).not.toContain("tenant create");
        expect(output.stdout).toContain("Options:");
        expect(output.stdout).toContain("-v, --version");
        expect(output.stdout).toContain("For more information");
    });

    it("registers ps and offers workload selection on logs", async () => {
        const { context, output } = await createContext();

        expect(await runCli(["ps", "--help"], context)).toBe(0);
        expect(output.stdout).toContain("Usage: eudiplo ps [options]");
        expect(output.stdout).toContain("--instance <name>");
        // ps reports the whole deployment, so it takes no workload selector.
        expect(output.stdout).not.toContain("--service <name>");

        const logs = await createContext();
        expect(await runCli(["logs", "--help"], logs.context)).toBe(0);
        expect(logs.output.stdout).toContain("--service <name>");
        expect(logs.output.stdout).toContain("--follow");
        expect(logs.output.stdout).toContain("--tail <lines>");
    });

    it("guards restart behind workload selection and read-only", async () => {
        const { context, output } = await createContext();

        expect(await runCli(["restart", "--help"], context)).toBe(0);
        expect(output.stdout).toContain("Usage: eudiplo restart [options]");
        expect(output.stdout).toContain("--service <name>");
        expect(output.stdout).toContain("--no-wait");
        expect(output.stdout).not.toContain("--follow");
    });

    it("treats -h like global help", async () => {
        const { context, output } = await createContext();

        const code = await runCli(["-h"], context);

        expect(code).toBe(0);
        expect(output.stdout).toContain("Commands:");
        expect(output.stdout).toContain("--help");
    });

    it("prints command-specific help", async () => {
        const { context, output } = await createContext();

        const code = await runCli(["init", "--help"], context);

        expect(code).toBe(0);
        expect(output.stdout).toContain(
            "Usage: eudiplo init [options] [directory]",
        );
        expect(output.stdout).toContain("--target <compose|external>");
        expect(output.stdout).toContain("--instance <name>");
        expect(output.stdout).toContain("--directory <path>");
        expect(output.stdout).toContain("--preset <minimal|standard|full>");
        expect(output.stdout).toContain("--database <sqlite|postgres>");
        expect(output.stdout).toContain("--storage <local|s3>");
        expect(output.stdout).toContain("--auth-client-secret <secret>");
        expect(output.stdout).toContain("--demo-tenant");
        expect(output.stdout).toContain("--demo");
        expect(output.stdout).toContain("--image-tag <tag>");
        expect(output.stdout).toContain("--no-client");
        expect(output.stdout).not.toContain("Commands:\n    eudiplo demo");
    });

    it("treats -h like command-specific help", async () => {
        const { context, output } = await createContext();

        const code = await runCli(["init", "-h"], context);

        expect(code).toBe(0);
        expect(output.stdout).toContain(
            "Usage: eudiplo init [options] [directory]",
        );
        expect(output.stdout).toContain("--no-client");
        expect(output.stdout).not.toContain("Commands:\n    eudiplo demo");
    });

    it("shows hierarchical config command help", async () => {
        const { context, output } = await createContext();

        expect(await runCli(["config"], context)).toBe(0);
        expect(output.stdout).toContain(
            "Usage: eudiplo config [options] [command]",
        );
        expect(output.stdout).toContain("path");
        expect(output.stdout).toContain("show [options]");
        expect(output.stdout).toContain("validate");
        expect(output.stdout).toContain("editor");
        expect(output.stdout).toContain("tenant");
        expect(output.stdout).not.toContain("tenant create");

        output.stdout = "";
        expect(await runCli(["config", "tenant"], context)).toBe(0);
        expect(output.stdout).toContain(
            "Usage: eudiplo config tenant [options] [command]",
        );
        expect(output.stdout).toContain("create|new [options] <tenant-id>");
        expect(output.stdout).toContain("validate [options] [tenant-id]");
        expect(output.stdout).toContain("remove|rm [options] <tenant-id>");

        output.stdout = "";
        expect(
            await runCli(["config", "editor", "setup", "--help"], context),
        ).toBe(0);
        expect(output.stdout).toContain(
            "Usage: eudiplo config editor setup [options] [workspace]",
        );
        expect(output.stdout).toContain("--config-directory <path>");

        output.stdout = "";
        expect(await runCli(["config", "export", "--help"], context)).toBe(0);
        expect(output.stdout).toContain("--output <path>");
        expect(output.stdout).not.toContain("--policy");

        output.stdout = "";
        expect(
            await runCli(["config", "tenant", "create", "--help"], context),
        ).toBe(0);
        expect(output.stdout).toContain(
            "Usage: eudiplo config tenant create|new [options] <tenant-id>",
        );
        expect(output.stdout).toContain("--template <empty|demo>");
        expect(output.stdout).not.toContain("Commands:");

        output.stdout = "";
        expect(
            await runCli(["config", "tenant", "validate", "--help"], context),
        ).toBe(0);
        expect(output.stdout).toContain(
            "Usage: eudiplo config tenant validate [options] [tenant-id]",
        );
        expect(output.stdout).toContain(
            "Validate one or all local tenant configurations",
        );

        output.stdout = "";
        expect(await runCli(["config", "help", "tenant"], context)).toBe(0);
        expect(output.stdout).toContain("Usage: eudiplo config tenant");
    });

    it("lists the complete nested command tree", async () => {
        const { context, output } = await createContext();

        const code = await runCli(["commands"], context);

        expect(code).toBe(0);
        expect(output.stdout).toContain("Available commands:");
        expect(output.stdout).toContain(
            "eudiplo config editor setup [options] [workspace]",
        );
        expect(output.stdout).toContain("eudiplo config tenant create|new");
        expect(output.stdout).toContain(
            "eudiplo instance add [options] <name>",
        );
        expect(output.stdout).not.toContain("eudiplo _complete");
    });

    it("renders the complete command reference as Markdown", async () => {
        const { context, output } = await createContext();

        const code = await runCli(
            ["commands", "--format", "markdown"],
            context,
        );

        expect(code).toBe(0);
        expect(output.stdout).toContain("# EUDIPLO CLI command reference");
        expect(output.stdout).toContain("## `eudiplo config editor setup`");
        expect(output.stdout).toContain(
            "Usage: eudiplo config editor setup [options] [workspace]",
        );
        expect(output.stdout).toContain("--config-directory <path>");
        expect(output.stdout).not.toContain("## `eudiplo _complete`");
    });

    it("shows instance subcommands before action help", async () => {
        const { context, output } = await createContext();

        expect(await runCli(["instance"], context)).toBe(0);
        expect(output.stdout).toContain(
            "Usage: eudiplo instance [options] [command]",
        );
        expect(output.stdout).toContain("list|ls");
        expect(output.stdout).toContain("show [name]");
        expect(output.stdout).toContain("use <name>");
        expect(output.stdout).toContain("remove|rm <name>");
        expect(output.stdout).toContain("add [options] <name>");

        output.stdout = "";
        expect(await runCli(["instance", "add", "--help"], context)).toBe(0);
        expect(output.stdout).toContain(
            "Usage: eudiplo instance add [options] <name>",
        );
        expect(output.stdout).toContain("--url <url>");
    });

    it("rejects unknown options and missing required command arguments", async () => {
        const { context, output } = await createContext();

        expect(await runCli(["init", "--databse", "sqlite"], context)).toBe(1);
        expect(output.stderr).toContain("unknown option '--databse'");

        output.stderr = "";
        expect(await runCli(["config", "tenant", "create"], context)).toBe(1);
        expect(output.stderr).toContain(
            "missing required argument 'tenant-id'",
        );
    });

    it("prints the package version", async () => {
        const { context, output } = await createContext();

        const code = await runCli(["--version"], context);

        expect(code).toBe(0);
        expect(output.stdout).toMatch(/^@eudiplo\/cli \d+\.\d+\.\d+/);
    });

    it("keeps short version aliases local-only", async () => {
        const { context, output } = await createContext();

        expect(await runCli(["-v"], context)).toBe(0);
        expect(output.stdout).toMatch(/@eudiplo\/cli \d+\.\d+\.\d+/);
        expect(output.stdout).not.toContain("latest");
    });

    it("checks the latest published version", async () => {
        const { context, output } = await createContext({
            fetch: async () => Response.json({ version: "99.0.0" }),
        });

        const code = await runCli(["version"], context);

        expect(code).toBe(0);
        expect(output.stdout).toContain("@eudiplo/cli");
        expect(output.stdout).toContain("latest 99.0.0");
        expect(output.stdout).toContain(
            "update available: npm install -g @eudiplo/cli@latest",
        );
    });

    it("uses the standalone installer when the binary has an update", async () => {
        const { context, output } = await createContext({
            fetch: async () => Response.json({ version: "99.0.0" }),
            installationMethod: "standalone",
        });

        const code = await runCli(["version"], context);

        expect(code).toBe(0);
        expect(output.stdout).toContain(
            "update available: curl -fsSL https://eudiplo.dev/install.sh | bash",
        );
        expect(output.stdout).not.toContain("npm install -g");
    });

    it("does not fail version output when the registry is unavailable", async () => {
        const { context, output } = await createContext({
            fetch: async () => new Response("not found", { status: 404 }),
        });

        const code = await runCli(["version"], context);

        expect(code).toBe(0);
        expect(output.stdout).toContain(
            "latest unavailable: npm registry returned HTTP 404",
        );
    });

    it("generates completion scripts for supported shells", async () => {
        const { context, output } = await createContext();
        const expectations = {
            bash: "complete -F _eudiplo_completion eudiplo",
            zsh: "#compdef eudiplo",
            fish: "complete -c eudiplo",
            powershell:
                "Register-ArgumentCompleter -Native -CommandName eudiplo",
        };

        for (const [shell, marker] of Object.entries(expectations)) {
            output.stdout = "";
            expect(await runCli(["completion", shell], context)).toBe(0);
            expect(output.stdout).toContain(marker);
            expect(output.stdout).toContain("eudiplo _complete");
        }
    });

    it("provides dynamic command, option, and choice completion candidates", async () => {
        const { context, output, configPath } = await createContext();
        await writeFile(
            configPath,
            JSON.stringify({
                instances: {
                    development: {
                        target: "compose",
                        url: "http://localhost:3000",
                    },
                    production: {
                        target: "external",
                        url: "https://eudiplo.example.com",
                    },
                },
            }),
        );

        expect(await runCli(["_complete"], context)).toBe(0);
        expect(output.stdout).toContain("instance\n");
        expect(output.stdout).toContain("completion\n");
        expect(output.stdout).not.toContain("_complete\n");

        output.stdout = "";
        expect(await runCli(["_complete", "config"], context)).toBe(0);
        expect(output.stdout).toContain("path\n");
        expect(output.stdout).toContain("show\n");
        expect(output.stdout).toContain("tenant\n");

        output.stdout = "";
        expect(await runCli(["_complete", "config", "show"], context)).toBe(0);
        expect(output.stdout).toContain("--json\n");

        output.stdout = "";
        expect(await runCli(["_complete", "completion"], context)).toBe(0);
        expect(output.stdout).toContain("bash\n");
        expect(output.stdout).toContain("powershell\n");

        output.stdout = "";
        expect(await runCli(["_complete", "init", "--target"], context)).toBe(
            0,
        );
        expect(output.stdout).toContain("compose\n");
        expect(output.stdout).toContain("external\n");

        output.stdout = "";
        expect(await runCli(["_complete", "up", "--instance"], context)).toBe(
            0,
        );
        expect(output.stdout).toContain("development\n");
        expect(output.stdout).toContain("production\n");
    });

    it("registers an external instance without storing secrets", async () => {
        const { context, output, configPath } = await createContext();

        const code = await runCli(
            [
                "instance",
                "add",
                "production",
                "--url",
                "https://eudiplo.example.com",
            ],
            context,
        );

        expect(code).toBe(0);
        expect(output.stdout).toContain("Added external instance production.");

        const config = JSON.parse(await readFile(configPath, "utf8"));
        expect(config.instances.production).toEqual({
            target: "external",
            url: "https://eudiplo.example.com",
        });
        expect(JSON.stringify(config)).not.toContain("secret");
    });

    it("lists configured instances through the ls alias", async () => {
        const { context, output } = await createContext();

        expect(await runCli(["instance", "ls"], context)).toBe(0);
        expect(output.stdout).toBe("No configured instances.\n");

        await runCli(
            [
                "instance",
                "add",
                "production",
                "--url",
                "https://eudiplo.example.com",
            ],
            context,
        );
        await runCli(
            ["instance", "add", "alpha", "--url", "https://alpha.example.com"],
            context,
        );
        output.stdout = "";

        expect(await runCli(["instance", "ls"], context)).toBe(0);
        expect(output.stdout).toBe(
            "Configured instances:\n" +
                "- alpha: external https://alpha.example.com\n" +
                "- production (default): external https://eudiplo.example.com\n",
        );
    });

    it("changes the default instance and shows its details", async () => {
        const { context, output } = await createContext();
        await runCli(
            [
                "instance",
                "add",
                "production",
                "--url",
                "https://eudiplo.example.com",
            ],
            context,
        );
        await runCli(
            [
                "instance",
                "add",
                "staging",
                "--url",
                "https://staging.example.com",
                "--client-url",
                "https://client.staging.example.com",
            ],
            context,
        );
        output.stdout = "";

        expect(await runCli(["instance", "use", "staging"], context)).toBe(0);
        expect(output.stdout).toContain("Default instance set to staging.");

        output.stdout = "";
        expect(await runCli(["instance", "show"], context)).toBe(0);
        expect(output.stdout).toContain("Instance staging (default)");
        expect(output.stdout).toContain("Target: external");
        expect(output.stdout).toContain("API URL: https://staging.example.com");
        expect(output.stdout).toContain(
            "Client URL: https://client.staging.example.com",
        );
    });

    it("unregisters non-default and final instances without removing deployments", async () => {
        const { context, output, configPath } = await createContext();
        await runCli(
            [
                "instance",
                "add",
                "production",
                "--url",
                "https://eudiplo.example.com",
            ],
            context,
        );
        await runCli(
            [
                "instance",
                "add",
                "staging",
                "--url",
                "https://staging.example.com",
            ],
            context,
        );

        output.stdout = "";
        expect(await runCli(["instance", "rm", "staging"], context)).toBe(0);
        expect(output.stdout).toContain("Unregistered instance staging.");
        expect(output.stdout).toContain(
            "Deployment resources were not removed.",
        );

        output.stdout = "";
        expect(
            await runCli(["instance", "remove", "production"], context),
        ).toBe(0);
        const config = JSON.parse(await readFile(configPath, "utf8"));
        expect(config).toEqual({ instances: {} });
    });

    it("requires switching before unregistering the default instance", async () => {
        const { context, output } = await createContext();
        await runCli(
            [
                "instance",
                "add",
                "production",
                "--url",
                "https://eudiplo.example.com",
            ],
            context,
        );
        await runCli(
            [
                "instance",
                "add",
                "staging",
                "--url",
                "https://staging.example.com",
            ],
            context,
        );
        output.stdout = "";

        expect(
            await runCli(["instance", "remove", "production"], context),
        ).toBe(1);
        expect(output.stderr).toContain(
            "Cannot remove default instance production",
        );
        expect(output.stderr).toContain("eudiplo instance use <name>");
    });

    it("rejects compose-only commands for external instances", async () => {
        const { context, output } = await createContext();
        await runCli(
            [
                "instance",
                "add",
                "production",
                "--url",
                "https://eudiplo.example.com",
            ],
            context,
        );

        const code = await runCli(
            ["logs", "--instance", "production"],
            context,
        );

        expect(code).toBe(1);
        expect(output.stderr).toContain(
            "logs is not available for externally managed deployments",
        );
    });

    it("initializes compose instances with standard compose assets by default", async () => {
        const { context, output, cwd } = await createContext();

        const code = await runCli(["init", "--target", "compose"], context);

        expect(code).toBe(0);
        expect(output.stdout).toContain("Initialized compose instance local.");
        await expect(
            readFile(join(cwd, "eudiplo.compose.yaml"), "utf8"),
        ).resolves.toContain(
            "EUDIPLO Docker Compose - Multi-Profile Deployment",
        );
        const env = await readFile(join(cwd, ".eudiplo.env"), "utf8");
        expect(env).toContain("EUDIPLO_IMAGE=ghcr.io/eudiplo/eudiplo:latest");
        expect(env).toContain(
            "EUDIPLO_CLIENT_IMAGE=ghcr.io/eudiplo/eudiplo-client:latest",
        );
        expect(env).toContain("AUTH_CLIENT_ID=root");
        expect(env).toContain("DB_TYPE=sqlite");
        expect(env).toContain("STORAGE_DRIVER=local");
        expect(env).toContain("EUDIPLO_CONFIG_MOUNT=./config:/app/config");
        expect(env).not.toContain("AUTH_CLIENT_SECRET=root");
        await expect(
            readFile(join(cwd, "config", "kms.json"), "utf8"),
        ).resolves.toContain('"defaultProvider": "db"');
        await expect(
            readFile(join(cwd, "config", "demo", "info.json"), "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("creates init assets in a positional project directory", async () => {
        const { context, cwd, configPath } = await createContext();
        const projectDirectory = join(cwd, "deployments", "local");

        const code = await runCli(
            ["init", "--no-client", projectDirectory, "--preset", "standard"],
            context,
        );

        expect(code).toBe(0);
        await expect(
            readFile(join(projectDirectory, "eudiplo.compose.yaml"), "utf8"),
        ).resolves.toContain(
            "EUDIPLO Docker Compose - Multi-Profile Deployment",
        );
        await expect(
            readFile(join(projectDirectory, ".eudiplo.env"), "utf8"),
        ).resolves.toContain("DB_TYPE=postgres");

        const config = JSON.parse(await readFile(configPath, "utf8"));
        expect(config.instances.local.projectDirectory).toBe(projectDirectory);
        expect(config.instances.local.composeProfiles).toEqual([
            "postgres",
            "s3",
        ]);
        expect(config.instances.local.clientUrl).toBeUndefined();
    });

    it("supports the directory flag and uses the saved directory from another cwd", async () => {
        const { context, cwd } = await createContext();
        const projectDirectory = join(cwd, "custom-project");
        const otherDirectory = await mkdtemp(
            join(tmpdir(), "eudiplo-cli-other-"),
        );
        const originalUp = drivers.compose.up;
        let receivedDirectory: string | undefined;
        drivers.compose.up = async ({ instance }) => {
            receivedDirectory = instance.projectDirectory;
            return 0;
        };

        try {
            expect(
                await runCli(
                    ["init", "--directory", "custom-project", "--yes"],
                    context,
                ),
            ).toBe(0);
            context.cwd = otherDirectory;

            expect(await runCli(["up"], context)).toBe(0);
            expect(receivedDirectory).toBe(projectDirectory);
        } finally {
            drivers.compose.up = originalUp;
        }
    });

    it("rejects a project directory that points to a file", async () => {
        const { context, output, cwd } = await createContext();
        const filePath = join(cwd, "not-a-directory");
        await writeFile(filePath, "content", "utf8");

        const code = await runCli(["init", filePath, "--yes"], context);

        expect(code).toBe(1);
        expect(output.stderr).toContain(
            `Project directory points to a file: ${filePath}`,
        );
    });

    it("initializes the standard preset with PostgreSQL and RustFS", async () => {
        const { context, cwd, configPath } = await createContext();

        const code = await runCli(
            [
                "init",
                "--preset",
                "standard",
                "--public-url",
                "https://eudiplo.example.com",
                "--auth-client-id",
                "example-client",
                "--auth-client-secret",
                "example-secret",
            ],
            context,
        );

        expect(code).toBe(0);
        const env = await readFile(join(cwd, ".eudiplo.env"), "utf8");
        expect(env).toContain("PUBLIC_URL=https://eudiplo.example.com");
        expect(env).toContain("AUTH_CLIENT_ID=example-client");
        expect(env).toContain("AUTH_CLIENT_SECRET=example-secret");
        expect(env).toContain("DB_TYPE=postgres");
        expect(env).toContain("STORAGE_DRIVER=s3");
        expect(env).not.toContain("KM_TYPE");
        expect(env).not.toContain("VAULT_ADDR=");

        const config = JSON.parse(await readFile(configPath, "utf8"));
        expect(config.instances.local.url).toBe("https://eudiplo.example.com");
        expect(config.instances.local.composeProfiles).toEqual([
            "postgres",
            "s3",
        ]);
    });

    it("supports custom component combinations", async () => {
        const { context, cwd, configPath } = await createContext();

        const code = await runCli(
            [
                "init",
                "--database",
                "postgres",
                "--storage",
                "local",
                "--kms",
                "vault",
            ],
            context,
        );

        expect(code).toBe(0);
        const env = await readFile(join(cwd, ".eudiplo.env"), "utf8");
        expect(env).toContain("DB_TYPE=postgres");
        expect(env).toContain("STORAGE_DRIVER=local");
        expect(env).not.toContain("KM_TYPE");
        expect(env).toContain("VAULT_ADDR=http://vault:8200");

        const config = JSON.parse(await readFile(configPath, "utf8"));
        expect(config.instances.local.composeProfiles).toEqual([
            "postgres",
            "vault",
        ]);
    });

    it("adds the bundled demo tenant during init only when requested", async () => {
        const { context, cwd } = await createContext();

        expect(
            await runCli(["init", "--demo-tenant", "--kms", "vault"], context),
        ).toBe(0);

        await expect(
            readFile(join(cwd, "config", "demo", "info.json"), "utf8"),
        ).resolves.toContain("Demo Tenant");
        const kmsConfig = JSON.parse(
            await readFile(join(cwd, "config", "kms.json"), "utf8"),
        );
        expect(kmsConfig.defaultProvider).toBe("vault");
        expect(
            kmsConfig.providers.map((provider: { id: string }) => provider.id),
        ).toEqual(["db", "vault"]);
    });

    it("collects missing init values with the interactive wizard", async () => {
        const answers = [
            "",
            "standard",
            "no",
            "https://wizard.example.com",
            "wizard-client",
            "wizard-secret",
            "no",
            "no",
        ];
        const { context, cwd, configPath } = await createContext({
            interactive: true,
            prompt: async () => answers.shift() ?? "",
        });

        const code = await runCli(["init"], context);

        expect(code).toBe(0);
        const env = await readFile(join(cwd, ".eudiplo.env"), "utf8");
        expect(env).toContain("PUBLIC_URL=https://wizard.example.com");
        expect(env).toContain("AUTH_CLIENT_ID=wizard-client");
        expect(env).toContain("AUTH_CLIENT_SECRET=wizard-secret");
        expect(env).toContain("DB_TYPE=postgres");
        expect(env).toContain("STORAGE_DRIVER=s3");

        const config = JSON.parse(await readFile(configPath, "utf8"));
        expect(config.instances.local.clientUrl).toBeUndefined();
        expect(answers).toEqual([]);
    });

    it("prompts for an omitted init project directory", async () => {
        const answers = ["generated-project", "no"];
        const questions: string[] = [];
        const { context, cwd, configPath } = await createContext({
            interactive: true,
            prompt: async (question) => {
                questions.push(question);
                return answers.shift() ?? "";
            },
        });

        const code = await runCli(
            [
                "init",
                "--preset",
                "minimal",
                "--no-demo-tenant",
                "--public-url",
                "http://localhost:3000",
                "--auth-client-id",
                "root",
                "--auth-client-secret",
                "secret",
                "--no-client",
            ],
            context,
        );

        expect(code).toBe(0);
        expect(questions[0]).toBe("Project directory [./]: ");
        await expect(
            readFile(join(cwd, "generated-project", ".eudiplo.env"), "utf8"),
        ).resolves.toContain("EUDIPLO_IMAGE=ghcr.io/eudiplo/eudiplo:latest");
        const config = JSON.parse(await readFile(configPath, "utf8"));
        expect(config.instances.local.projectDirectory).toBe(
            join(cwd, "generated-project"),
        );
        expect(answers).toEqual([]);
    });

    it("starts an initialized deployment when requested", async () => {
        const { context, output } = await createContext();
        const originalUp = drivers.compose.up;
        let profiles: string[] | undefined;
        drivers.compose.up = async ({ instance }) => {
            profiles = instance.composeProfiles;
            return 0;
        };

        try {
            const code = await runCli(
                ["init", "--preset", "full", "--start"],
                context,
            );

            expect(code).toBe(0);
            expect(output.stdout).toContain(
                "Starting EUDIPLO with the Compose runtime...",
            );
            expect(profiles).toEqual(["postgres", "s3", "vault"]);
        } finally {
            drivers.compose.up = originalUp;
        }
    });

    it("initializes compose demo instances with editable demo config when requested", async () => {
        const { context, output, cwd } = await createContext();

        const code = await runCli(
            ["init", "--target", "compose", "--demo"],
            context,
        );

        expect(code).toBe(0);
        expect(output.stdout).toContain("Initialized compose instance local.");
        await expect(
            readFile(join(cwd, ".eudiplo.demo.env"), "utf8"),
        ).resolves.toContain("EUDIPLO_IMAGE=ghcr.io/eudiplo/eudiplo:latest");
        await expect(
            readFile(join(cwd, ".eudiplo.demo.env"), "utf8"),
        ).resolves.toContain(
            "EUDIPLO_CLIENT_IMAGE=ghcr.io/eudiplo/eudiplo-client:latest",
        );
        await expect(
            readFile(join(cwd, ".eudiplo.demo.env"), "utf8"),
        ).resolves.toContain("EUDIPLO_BIND_ADDRESS=127.0.0.1");
        await expect(
            readFile(join(cwd, ".eudiplo.demo.env"), "utf8"),
        ).resolves.toContain("EUDIPLO_CONFIG_MOUNT=./config:/app/config");
    });

    it("accepts demo image tag overrides", async () => {
        const { context, cwd } = await createContext();

        const code = await runCli(
            ["init", "--target", "compose", "--demo", "--image-tag", "main"],
            context,
        );

        expect(code).toBe(0);
        await expect(
            readFile(join(cwd, ".eudiplo.demo.env"), "utf8"),
        ).resolves.toContain("EUDIPLO_IMAGE=ghcr.io/eudiplo/eudiplo:main");
        await expect(
            readFile(join(cwd, ".eudiplo.demo.env"), "utf8"),
        ).resolves.toContain(
            "EUDIPLO_CLIENT_IMAGE=ghcr.io/eudiplo/eudiplo-client:main",
        );
    });

    it("keeps init demo compatibility options", async () => {
        const { context, cwd, configPath } = await createContext();

        const code = await runCli(["init", "--demo", "--no-client"], context);

        expect(code).toBe(0);
        await expect(
            readFile(join(cwd, "eudiplo.compose.override.yaml"), "utf8"),
        ).resolves.toContain('profiles: ["disabled"]');
        const config = JSON.parse(await readFile(configPath, "utf8"));
        expect(config.instances.local.clientUrl).toBeUndefined();
        expect(config.instances.local.composeProfiles).toBeUndefined();
    });

    it("initializes compose instances without the client when requested", async () => {
        const { context, output, cwd, configPath } = await createContext();

        const code = await runCli(
            ["init", "--target", "compose", "--no-client"],
            context,
        );

        expect(code).toBe(0);
        expect(output.stdout).toContain("Initialized compose instance local.");
        await expect(
            readFile(join(cwd, "eudiplo.compose.override.yaml"), "utf8"),
        ).resolves.toContain('profiles: ["disabled"]');

        const config = JSON.parse(await readFile(configPath, "utf8"));
        expect(config.instances.local.composeFiles).toEqual([
            "eudiplo.compose.yaml",
            "eudiplo.compose.override.yaml",
        ]);
        expect(config.instances.local.clientUrl).toBeUndefined();
    });

    it("removes the no-client override when reinitialized without the flag", async () => {
        const { context, cwd } = await createContext();

        expect(
            await runCli(
                ["init", "--target", "compose", "--no-client"],
                context,
            ),
        ).toBe(0);
        expect(await runCli(["init", "--target", "compose"], context)).toBe(0);

        await expect(
            readFile(join(cwd, "eudiplo.compose.override.yaml"), "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("reports compose commands with the client enabled", async () => {
        const { context, output } = await createContext();
        const originalUp = drivers.compose.up;
        drivers.compose.up = async () => 0;

        try {
            expect(await runCli(["init", "--target", "compose"], context)).toBe(
                0,
            );
            output.stdout = "";

            expect(await runCli(["up"], context)).toBe(0);
            expect(output.stdout).toContain("up local (client enabled)");
        } finally {
            drivers.compose.up = originalUp;
        }
    });

    it("reports compose commands with the client disabled", async () => {
        const { context, output } = await createContext();
        const originalLogs = drivers.compose.logs;
        drivers.compose.logs = async () => 0;

        try {
            expect(
                await runCli(
                    ["init", "--target", "compose", "--no-client"],
                    context,
                ),
            ).toBe(0);
            output.stdout = "";

            expect(await runCli(["logs"], context)).toBe(0);
            expect(output.stdout).toContain("logs local (client disabled)");
        } finally {
            drivers.compose.logs = originalLogs;
        }
    });

    it("selects Podman when requested with EUDIPLO_CONTAINER_RUNTIME", async () => {
        const { cwd } = await createContext();
        const binDirectory = join(cwd, "bin");
        const podmanPath = join(binDirectory, "podman");
        await mkdir(binDirectory);
        await writeFile(podmanPath, "#!/bin/sh\nexit 0\n", "utf8");
        await chmod(podmanPath, 0o700);

        const runtime = await resolveComposeRuntime({
            EUDIPLO_CONTAINER_RUNTIME: "podman",
            PATH: binDirectory,
        });

        expect(runtime?.name).toBe("podman");
        expect(basename(runtime?.command ?? "")).toBe("podman");
    });

    it("rejects unsupported container runtime preferences", async () => {
        await expect(
            resolveComposeRuntime({ EUDIPLO_CONTAINER_RUNTIME: "nerdctl" }),
        ).rejects.toThrow(
            "EUDIPLO_CONTAINER_RUNTIME must be docker or podman.",
        );
    });

    it("demo generates local assets and starts compose", async () => {
        const { context, output, cwd } = await createContext();
        const originalUp = drivers.compose.up;
        drivers.compose.up = async () => 0;

        try {
            const code = await runCli(["demo"], context);

            expect(code).toBe(0);
            expect(output.stdout).toContain(
                "Starting EUDIPLO demo with the Compose runtime...",
            );
            expect(output.stdout).toContain("Demo mode - not for production.");
            await expect(
                readFile(join(cwd, ".eudiplo.demo.env"), "utf8"),
            ).resolves.toContain(
                "EUDIPLO_IMAGE=ghcr.io/eudiplo/eudiplo:latest",
            );
            const env = await readFile(join(cwd, ".eudiplo.demo.env"), "utf8");
            expect(env).toContain("DB_TYPE=sqlite");
            expect(env).toContain("STORAGE_DRIVER=local");
            expect(env).not.toContain("DB_HOST=postgres");
            await expect(
                readFile(join(cwd, "config", "demo", "info.json"), "utf8"),
            ).resolves.toContain("Demo Tenant");
        } finally {
            drivers.compose.up = originalUp;
        }
    });

    it("creates and starts a demo in a positional project directory", async () => {
        const { context, cwd, configPath } = await createContext();
        const projectDirectory = join(cwd, "demo-project");
        const originalUp = drivers.compose.up;
        let receivedDirectory: string | undefined;
        drivers.compose.up = async ({ instance }) => {
            receivedDirectory = instance.projectDirectory;
            return 0;
        };

        try {
            const code = await runCli(["demo", projectDirectory], context);

            expect(code).toBe(0);
            expect(receivedDirectory).toBe(projectDirectory);
            await expect(
                readFile(join(projectDirectory, ".eudiplo.demo.env"), "utf8"),
            ).resolves.toContain("DB_TYPE=sqlite");
            const config = JSON.parse(await readFile(configPath, "utf8"));
            expect(config.instances.local.projectDirectory).toBe(
                projectDirectory,
            );
        } finally {
            drivers.compose.up = originalUp;
        }
    });

    it("prompts for an omitted demo project directory", async () => {
        const { context, cwd, configPath } = await createContext({
            interactive: true,
            prompt: async () => "prompted-demo",
        });
        const originalUp = drivers.compose.up;
        drivers.compose.up = async () => 0;

        try {
            expect(await runCli(["demo"], context)).toBe(0);
            await expect(
                readFile(
                    join(cwd, "prompted-demo", ".eudiplo.demo.env"),
                    "utf8",
                ),
            ).resolves.toContain("DB_TYPE=sqlite");
            const config = JSON.parse(await readFile(configPath, "utf8"));
            expect(config.instances.local.projectDirectory).toBe(
                join(cwd, "prompted-demo"),
            );
        } finally {
            drivers.compose.up = originalUp;
        }
    });

    it("init --demo does not overwrite existing demo config without --force", async () => {
        const { context, cwd } = await createContext();
        const customFile = join(cwd, "config", "demo", "info.json");

        expect(
            await runCli(["init", "--target", "compose", "--demo"], context),
        ).toBe(0);
        await writeFile(customFile, "custom-demo-config", "utf8");

        expect(
            await runCli(["init", "--target", "compose", "--demo"], context),
        ).toBe(0);
        await expect(readFile(customFile, "utf8")).resolves.toBe(
            "custom-demo-config",
        );
    });

    it("demo --reset requires --force", async () => {
        const { context, output } = await createContext();

        const code = await runCli(["demo", "--reset"], context);

        expect(code).toBe(1);
        expect(output.stderr).toContain("demo --reset requires --force");
    });

    it("demo --reset --force removes only managed demo deployment data", async () => {
        const { context, cwd } = await createContext();
        const originalDown = drivers.compose.down;
        const originalUp = drivers.compose.up;
        const calls = [] as string[];
        drivers.compose.down = async (options) => {
            calls.push(options.args.join(" "));
            return 0;
        };
        drivers.compose.up = async () => 0;

        try {
            await writeFile(join(cwd, ".eudiplo.env"), "manual-env", "utf8");
            expect(await runCli(["demo"], context)).toBe(0);
            expect(await runCli(["demo", "--reset", "--force"], context)).toBe(
                0,
            );
            await expect(
                readFile(join(cwd, ".eudiplo.env"), "utf8"),
            ).resolves.toBe("manual-env");
            expect(calls).toContain("--volumes --remove-orphans");
        } finally {
            drivers.compose.down = originalDown;
            drivers.compose.up = originalUp;
        }
    });

    it("creates, lists, and removes local tenant configuration", async () => {
        const { context, output, cwd } = await createContext();
        expect(await runCli(["init", "--yes"], context)).toBe(0);
        output.stdout = "";

        expect(
            await runCli(
                [
                    "config",
                    "tenant",
                    "create",
                    "acme",
                    "--name",
                    "Acme GmbH",
                    "--description",
                    "Example tenant",
                ],
                context,
            ),
        ).toBe(0);

        const tenantPath = join(cwd, "config", "acme");
        expect(
            JSON.parse(await readFile(join(tenantPath, "info.json"), "utf8")),
        ).toEqual({
            $schema:
                "https://eudiplo.dev/schemas/v1/TenantConfigFile.schema.json",
            metadata: {
                generation: 1,
            },
            spec: {
                name: "Acme GmbH",
                description: "Example tenant",
            },
        });
        await expect(
            readFile(
                join(tenantPath, "issuance", "credentials", ".gitkeep"),
                "utf8",
            ),
        ).resolves.toBe("");
        await expect(
            readFile(join(tenantPath, "presentation", ".gitkeep"), "utf8"),
        ).resolves.toBe("");

        output.stdout = "";
        expect(await runCli(["config", "tenant", "ls"], context)).toBe(0);
        expect(output.stdout).toContain("- acme (Acme GmbH)");

        output.stdout = "";
        expect(
            await runCli(["config", "tenant", "remove", "acme"], context),
        ).toBe(1);
        expect(output.stderr).toContain(
            "config tenant remove requires --force",
        );
        expect(
            await runCli(
                ["config", "tenant", "rm", "acme", "--force"],
                context,
            ),
        ).toBe(0);
        expect(output.stdout).toContain(
            "running EUDIPLO instance was not deleted",
        );
        await expect(
            readFile(join(tenantPath, "info.json"), "utf8"),
        ).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("creates a demo tenant template under an explicit config root", async () => {
        const { context, cwd } = await createContext();
        const configRoot = join(cwd, "standalone-config");

        expect(
            await runCli(
                [
                    "config",
                    "tenant",
                    "new",
                    "sample",
                    "--template",
                    "demo",
                    "--config-directory",
                    configRoot,
                ],
                context,
            ),
        ).toBe(0);

        await expect(
            readFile(
                join(configRoot, "sample", "key-chains", "access.json"),
                "utf8",
            ),
        ).resolves.toContain('"kmsProvider": "db"');
        await expect(
            readFile(join(configRoot, "sample", "info.json"), "utf8"),
        ).resolves.toContain("Demo Tenant");
    });

    it("rejects unsafe tenant IDs", async () => {
        const { context, output, cwd } = await createContext();

        const code = await runCli(
            [
                "config",
                "tenant",
                "create",
                "../escape",
                "--config-directory",
                join(cwd, "config"),
            ],
            context,
        );

        expect(code).toBe(1);
        expect(output.stderr).toContain("Tenant ID must use lowercase letters");
    });

    it("runs doctor against external instances without Docker diagnostics", async () => {
        const { context, output } = await createContext({
            fetch: async (input) => {
                const url =
                    input instanceof URL ? input : new URL(String(input));
                return new Response("{}", {
                    status:
                        url.pathname === "/health" ||
                        url.pathname === "/api/docs"
                            ? 200
                            : 404,
                });
            },
        });
        await runCli(
            [
                "instance",
                "add",
                "production",
                "--url",
                "https://eudiplo.example.com",
            ],
            context,
        );

        const code = await runCli(
            ["doctor", "--instance", "production"],
            context,
        );

        expect(code).toBe(0);
        expect(output.stdout).toContain("PASS API reachability");
        expect(output.stdout).toContain("PASS health endpoint");
        expect(output.stdout).not.toContain("Docker is not available");
    });

    it("validates config and reports configured instances", async () => {
        const { context, output } = await createContext();
        await runCli(
            [
                "instance",
                "add",
                "production",
                "--url",
                "https://eudiplo.example.com",
            ],
            context,
        );

        const code = await runCli(["config", "validate"], context);

        expect(code).toBe(0);
        expect(output.stdout).toContain("Config is valid:");
        expect(output.stdout).toContain("Instances: 1");
        expect(output.stdout).toContain(
            "- production: external https://eudiplo.example.com",
        );
    });

    it("rejects invalid config URLs", async () => {
        const { context, output, configPath } = await createContext();
        await writeFile(
            configPath,
            JSON.stringify({
                instances: {
                    production: {
                        target: "external",
                        url: "not-a-url",
                    },
                },
            }),
            "utf8",
        );

        const code = await runCli(["config", "validate"], context);

        expect(code).toBe(1);
        expect(output.stderr).toContain(
            "Instance production url must be an absolute HTTP(S) URL.",
        );
    });

    it("prints the config path and shows validated config in text or JSON", async () => {
        const { context, output, configPath } = await createContext();
        await runCli(
            [
                "instance",
                "add",
                "production",
                "--url",
                "https://eudiplo.example.com",
                "--client-url",
                "https://client.eudiplo.example.com",
            ],
            context,
        );

        output.stdout = "";
        expect(await runCli(["config", "path"], context)).toBe(0);
        expect(output.stdout).toBe(`${configPath}\n`);

        output.stdout = "";
        expect(await runCli(["config", "show"], context)).toBe(0);
        expect(output.stdout).toContain(`Config: ${configPath}`);
        expect(output.stdout).toContain("Default instance: production");
        expect(output.stdout).toContain("- production (default)");
        expect(output.stdout).toContain("  target: external");
        expect(output.stdout).toContain(
            "  clientUrl: https://client.eudiplo.example.com",
        );

        output.stdout = "";
        expect(await runCli(["config", "show", "--json"], context)).toBe(0);
        expect(JSON.parse(output.stdout)).toEqual({
            defaultInstance: "production",
            instances: {
                production: {
                    target: "external",
                    url: "https://eudiplo.example.com",
                    clientUrl: "https://client.eudiplo.example.com",
                },
            },
        });
    });
});

async function createContext(
    options: {
        fetch?: typeof fetch;
        installationMethod?: CommandContext["installationMethod"];
        interactive?: boolean;
        prompt?: CommandContext["prompt"];
        readCertificate?: CommandContext["readCertificate"];
    } = {},
) {
    const cwd = await mkdtemp(join(tmpdir(), "eudiplo-cli-work-"));
    const home = await mkdtemp(join(tmpdir(), "eudiplo-cli-home-"));
    const configPath = join(home, "config.json");
    const output = { stdout: "", stderr: "" };
    const context: CommandContext = {
        cwd,
        env: {
            EUDIPLO_CLI_CONFIG: configPath,
            PATH: process.env.PATH,
        },
        installationMethod: options.installationMethod,
        interactive: options.interactive,
        prompt: options.prompt,
        // Never open a real TLS socket from the test suite.
        readCertificate:
            options.readCertificate ??
            (async () => ({
                subject: "eudiplo.example.com",
                issuer: "Test CA",
                validTo: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
            })),
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
        fetch: options.fetch ?? fetch,
    };

    return { context, output, cwd, configPath };
}
