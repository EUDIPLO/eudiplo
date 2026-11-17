import { randomBytes } from "node:crypto";
import { readStringFlag } from "../../options.js";
import { saveConfig, upsertInstance } from "../../services/cli-config.js";
import type {
    ComposeDatabase,
    ComposeKms,
    ComposeStorage,
} from "../../services/compose-project.js";
import {
    drivers,
    ensureComposeProject,
} from "../../services/deployment-drivers.js";
import { parseTarget } from "../../services/deployment-target.js";
import { resolveProjectDirectory } from "../../services/project-directory.js";
import { validateHttpUrl } from "../../services/url.js";
import type { CliConfig, CommandContext, ParsedArgs } from "../../types.js";
import { createPrompter, type Prompter } from "../shared.js";

type DeploymentPreset = "minimal" | "standard" | "full";

interface ComposeInitOptions {
    database: ComposeDatabase;
    storage: ComposeStorage;
    kms: ComposeKms;
    publicUrl: string;
    authClientId: string;
    authClientSecret: string;
    demoTenant: boolean;
    noClient: boolean;
    start: boolean;
}

export async function runInit(
    configPath: string,
    config: CliConfig,
    parsed: ParsedArgs,
    context: CommandContext,
): Promise<number> {
    const target = parseTarget(
        readStringFlag(parsed.flags, "target") ?? "compose",
    );
    const name = readStringFlag(parsed.flags, "instance") ?? "local";
    const url = readStringFlag(parsed.flags, "url");
    const useDemoMode = parsed.flags.demo === true;
    const force = parsed.flags.force === true;
    const imageTagOverride =
        readStringFlag(parsed.flags, "image-tag") ??
        context.env.EUDIPLO_IMAGE_TAG;

    if (target === "compose") {
        const shouldPrompt = shouldOpenWizard(parsed, context);
        const prompter = createPrompter(context);
        let projectDirectory: string;
        let initOptions: ComposeInitOptions;
        try {
            const directoryAnswer =
                shouldPrompt && !hasProjectDirectory(parsed)
                    ? await prompter.ask("Project directory [./]: ")
                    : undefined;
            projectDirectory = resolveProjectDirectory(
                parsed,
                context,
                directoryAnswer?.trim() || undefined,
            );
            initOptions = useDemoMode
                ? demoInitOptions(parsed)
                : await resolveComposeInitOptions(
                      parsed,
                      prompter,
                      shouldPrompt,
                  );
        } finally {
            prompter.close();
        }
        const instance = await ensureComposeProject(projectDirectory, {
            mode: useDemoMode ? "demo" : "standard",
            ...initOptions,
            force,
            imageTagOverride,
        });
        const nextConfig = upsertInstance(config, name, {
            ...instance,
            url: url ?? initOptions.publicUrl,
        });
        await saveConfig(configPath, nextConfig);
        context.stdout.write(`Initialized compose instance ${name}.\n`);
        context.stdout.write(
            `Configuration: database=${initOptions.database}, storage=${initOptions.storage}, kms=${initOptions.kms}, client=${initOptions.noClient ? "disabled" : "enabled"}, demo-tenant=${initOptions.demoTenant ? "included" : "disabled"}\n`,
        );
        context.stdout.write(`Project directory: ${projectDirectory}\n`);
        context.stdout.write(
            `Environment: ${projectDirectory}/${instance.envFile}\n`,
        );
        context.stdout.write(`Auth client ID: ${initOptions.authClientId}\n`);
        context.stdout.write(
            "Auth client secret: saved in the environment file\n",
        );
        if (initOptions.demoTenant && initOptions.kms === "vault") {
            context.stdout.write(
                "Note: bundled demo private keys explicitly use the db provider; Vault remains the default for new keys.\n",
            );
        }

        if (initOptions.start) {
            context.stdout.write(
                "Starting EUDIPLO with the Compose runtime...\n",
            );
            return (
                (await drivers.compose.up?.({
                    instanceName: name,
                    instance: nextConfig.instances[name],
                    args: [],
                    flags: {},
                    context,
                })) ?? 1
            );
        }

        context.stdout.write("Run npx @eudiplo/cli up to start it.\n");
        return 0;
    }

    if (parsed.subject || readStringFlag(parsed.flags, "directory")) {
        throw new Error(
            "Project directories are available only for compose instances.",
        );
    }
    if (!url) {
        throw new Error("External instances require --url.");
    }

    const nextConfig = upsertInstance(config, name, { target, url });
    await saveConfig(configPath, nextConfig);
    context.stdout.write(`Initialized external instance ${name}.\n`);
    return 0;
}

function demoInitOptions(parsed: ParsedArgs): ComposeInitOptions {
    if (parsed.flags.client === true && parsed.flags["no-client"] === true) {
        throw new Error("Use either --client or --no-client, not both.");
    }

    return {
        database: "sqlite",
        storage: "local",
        kms: "db",
        publicUrl: "http://localhost:3000",
        authClientId: "root",
        authClientSecret: "root",
        demoTenant: true,
        noClient: parsed.flags["no-client"] === true,
        start: parsed.flags.start === true,
    };
}

async function resolveComposeInitOptions(
    parsed: ParsedArgs,
    prompter: Prompter,
    shouldPrompt: boolean,
): Promise<ComposeInitOptions> {
    if (parsed.flags.client === true && parsed.flags["no-client"] === true) {
        throw new Error("Use either --client or --no-client, not both.");
    }
    if (
        parsed.flags["demo-tenant"] === true &&
        parsed.flags["no-demo-tenant"] === true
    ) {
        throw new Error(
            "Use either --demo-tenant or --no-demo-tenant, not both.",
        );
    }

    const presetFlag = readChoiceFlag(parsed, "preset", [
        "minimal",
        "standard",
        "full",
    ]);
    let database = readChoiceFlag(parsed, "database", ["sqlite", "postgres"]);
    let storage = readChoiceFlag(parsed, "storage", ["local", "s3"]);
    let kms = readChoiceFlag(parsed, "kms", ["db", "vault"]);
    let publicUrl = readStringFlag(parsed.flags, "public-url");
    let authClientId = readStringFlag(parsed.flags, "auth-client-id");
    let authClientSecret = readStringFlag(parsed.flags, "auth-client-secret");
    let demoTenant = parsed.flags["demo-tenant"] === true ? true : undefined;
    if (parsed.flags["no-demo-tenant"] === true) {
        demoTenant = false;
    }
    let noClient = parsed.flags["no-client"] === true ? true : undefined;
    if (parsed.flags.client === true) {
        noClient = false;
    }
    let start = parsed.flags.start === true ? true : undefined;

    const hasComponentFlag =
        database !== undefined || storage !== undefined || kms !== undefined;
    let preset = presetFlag;

    if (shouldPrompt && !preset && !hasComponentFlag) {
        const answer = (
            await prompter.ask(
                "Deployment preset (minimal/standard/full/custom) [minimal]: ",
            )
        )
            .trim()
            .toLowerCase();
        if (answer && answer !== "custom") {
            preset = parseChoice(answer, "preset", [
                "minimal",
                "standard",
                "full",
            ]);
        }
    }

    const presetOptions = presetValues(preset ?? "minimal");
    if (shouldPrompt && !preset) {
        database ??= await promptChoice(
            prompter.ask,
            "Database",
            ["sqlite", "postgres"],
            "sqlite",
        );
        storage ??= await promptChoice(
            prompter.ask,
            "Storage",
            ["local", "s3"],
            "local",
        );
        kms ??= await promptChoice(
            prompter.ask,
            "Key management",
            ["db", "vault"],
            "db",
        );
    }
    database ??= presetOptions.database;
    storage ??= presetOptions.storage;
    kms ??= presetOptions.kms;

    if (shouldPrompt && demoTenant === undefined) {
        demoTenant = await promptBoolean(
            prompter.ask,
            "Add the bundled demo tenant? Its private keys use the db provider.",
            false,
        );
    }
    demoTenant ??= false;

    if (shouldPrompt && !publicUrl) {
        publicUrl = await promptWithDefault(
            prompter.ask,
            "Public URL",
            "http://localhost:3000",
        );
    }
    publicUrl ??= "http://localhost:3000";

    if (shouldPrompt && !authClientId) {
        authClientId = await promptWithDefault(
            prompter.ask,
            "Auth client ID",
            "root",
        );
    }
    authClientId ??= "root";

    if (shouldPrompt && !authClientSecret) {
        const answer = await prompter.ask(
            "Auth client secret (leave blank to generate): ",
        );
        authClientSecret = answer.trim() || undefined;
    }
    authClientSecret ??= randomBytes(24).toString("base64url");

    if (shouldPrompt && noClient === undefined) {
        noClient = !(await promptBoolean(
            prompter.ask,
            "Include the web client?",
            true,
        ));
    }
    noClient ??= false;

    if (shouldPrompt && start === undefined) {
        start = await promptBoolean(
            prompter.ask,
            "Start the deployment now?",
            true,
        );
    }
    start ??= false;

    validateHttpUrl(publicUrl, "Public URL");
    validateEnvInput(publicUrl, "Public URL");
    validateEnvInput(authClientId, "Auth client ID");
    validateEnvInput(authClientSecret, "Auth client secret");

    return {
        database,
        storage,
        kms,
        publicUrl,
        authClientId,
        authClientSecret,
        demoTenant,
        noClient,
        start,
    };
}

function shouldOpenWizard(
    parsed: ParsedArgs,
    context: CommandContext,
): boolean {
    return (
        context.interactive === true &&
        parsed.flags.yes !== true &&
        parsed.flags["no-interactive"] !== true
    );
}

function hasProjectDirectory(parsed: ParsedArgs): boolean {
    return Boolean(parsed.subject || readStringFlag(parsed.flags, "directory"));
}

function presetValues(
    preset: DeploymentPreset,
): Pick<ComposeInitOptions, "database" | "storage" | "kms"> {
    if (preset === "standard") {
        return { database: "postgres", storage: "s3", kms: "db" };
    }
    if (preset === "full") {
        return { database: "postgres", storage: "s3", kms: "vault" };
    }
    return { database: "sqlite", storage: "local", kms: "db" };
}

function readChoiceFlag<const Values extends readonly string[]>(
    parsed: ParsedArgs,
    name: string,
    values: Values,
): Values[number] | undefined {
    const value = readStringFlag(parsed.flags, name);
    return value ? parseChoice(value, name, values) : undefined;
}

function parseChoice<const Values extends readonly string[]>(
    value: string,
    name: string,
    values: Values,
): Values[number] {
    if (values.includes(value)) {
        return value as Values[number];
    }
    throw new Error(
        `Unsupported --${name} value: ${value}. Use ${values.join(" or ")}.`,
    );
}

async function promptChoice<const Values extends readonly string[]>(
    prompt: (question: string) => Promise<string>,
    label: string,
    values: Values,
    defaultValue: Values[number],
): Promise<Values[number]> {
    const answer = (
        await prompt(`${label} (${values.join("/")}) [${defaultValue}]: `)
    )
        .trim()
        .toLowerCase();
    return answer
        ? parseChoice(answer, label.toLowerCase(), values)
        : defaultValue;
}

async function promptWithDefault(
    prompt: (question: string) => Promise<string>,
    label: string,
    defaultValue: string,
): Promise<string> {
    const answer = (await prompt(`${label} [${defaultValue}]: `)).trim();
    return answer || defaultValue;
}

async function promptBoolean(
    prompt: (question: string) => Promise<string>,
    label: string,
    defaultValue: boolean,
): Promise<boolean> {
    const suffix = defaultValue ? "Y/n" : "y/N";
    const answer = (await prompt(`${label} [${suffix}]: `))
        .trim()
        .toLowerCase();
    if (!answer) {
        return defaultValue;
    }
    if (answer === "y" || answer === "yes") {
        return true;
    }
    if (answer === "n" || answer === "no") {
        return false;
    }
    throw new Error(`Answer ${label.toLowerCase()} with yes or no.`);
}

function validateEnvInput(value: string, label: string): void {
    if (!value || /[\r\n]/.test(value)) {
        throw new Error(
            `${label} must be non-empty and cannot contain line breaks.`,
        );
    }
}
