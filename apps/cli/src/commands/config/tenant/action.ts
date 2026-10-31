import {
    access,
    mkdir,
    readdir,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { TENANT_ID_PATTERN } from "@eudiplo/config-format/config-format.js";
import { readStringFlag } from "../../../options.js";
import {
    configDirectoryName,
    copyBundledDemoConfig,
} from "../../../services/compose-project.js";
import type { CliConfig, CommandContext, ParsedArgs } from "../../../types.js";
import { validateTenantConfig } from "../validate/action.js";

const tenantDirectories = [
    "clients",
    "key-chains",
    "attribute-providers",
    "webhook-endpoints",
    "issuance/credentials",
    "issuance/status-lists",
    "presentation",
    "trust-lists",
    "images",
];

type TenantTemplate = "empty" | "demo";

export async function tenantCommand(
    config: CliConfig,
    parsed: ParsedArgs,
    context: CommandContext,
): Promise<number> {
    const action = normalizeAction(parsed.subject);
    const configRoot = resolveConfigRoot(config, parsed, context);

    if (action === "list") {
        if (parsed.positionals.length > 0) {
            throw new Error(`Unexpected argument: ${parsed.positionals[0]}`);
        }
        return listTenants(configRoot, context);
    }
    if (action === "create") {
        return createTenant(configRoot, parsed, context);
    }
    if (action === "validate") {
        return validateTenant(configRoot, parsed, context);
    }
    return removeTenant(configRoot, parsed, context);
}

function normalizeAction(
    subject: string | undefined,
): "list" | "create" | "validate" | "remove" {
    if (subject === "list" || subject === "ls") {
        return "list";
    }
    if (subject === "create" || subject === "new") {
        return "create";
    }
    if (subject === "validate") {
        return "validate";
    }
    if (subject === "remove" || subject === "rm" || subject === "delete") {
        return "remove";
    }
    throw new Error(
        "Usage: eudiplo config tenant <list|create|validate|remove> [tenant-id]",
    );
}

async function validateTenant(
    configRoot: string,
    parsed: ParsedArgs,
    context: CommandContext,
): Promise<number> {
    if (parsed.positionals.length > 1) {
        throw new Error(`Unexpected argument: ${parsed.positionals[1]}`);
    }

    const tenantId = parsed.positionals[0];
    const path = tenantId ? join(configRoot, tenantId) : configRoot;
    return validateTenantConfig(
        tenantId ? "tenant" : "tenants",
        {
            ...parsed,
            positionals: [tenantId ? "tenant" : "tenants", path],
        },
        context,
    );
}

function resolveConfigRoot(
    config: CliConfig,
    parsed: ParsedArgs,
    context: CommandContext,
): string {
    const explicitDirectory = readStringFlag(parsed.flags, "config-directory");
    const instanceName = readStringFlag(parsed.flags, "instance");
    if (explicitDirectory && instanceName) {
        throw new Error(
            "Use either --instance or --config-directory, not both.",
        );
    }
    if (explicitDirectory) {
        return resolve(context.cwd, explicitDirectory);
    }

    const selectedName = instanceName ?? config.defaultInstance;
    if (!selectedName) {
        throw new Error(
            "No instance selected. Use --instance or --config-directory to locate the config root.",
        );
    }
    const instance = config.instances[selectedName];
    if (!instance) {
        throw new Error(`Unknown instance: ${selectedName}`);
    }
    if (instance.target !== "compose") {
        throw new Error(
            "Local tenant configuration is available only for compose instances. Use --config-directory for an explicit config root.",
        );
    }

    return join(instance.projectDirectory ?? context.cwd, configDirectoryName);
}

async function listTenants(
    configRoot: string,
    context: CommandContext,
): Promise<number> {
    if (!(await exists(configRoot))) {
        context.stdout.write(
            `No local tenant configurations in ${configRoot}.\n`,
        );
        return 0;
    }

    const entries = await readdir(configRoot, { withFileTypes: true });
    const tenants: Array<{ id: string; name?: string }> = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const infoPath = join(configRoot, entry.name, "info.json");
        if (!(await exists(infoPath))) {
            continue;
        }
        tenants.push({ id: entry.name, name: await readTenantName(infoPath) });
    }
    tenants.sort((left, right) => left.id.localeCompare(right.id));

    if (tenants.length === 0) {
        context.stdout.write(
            `No local tenant configurations in ${configRoot}.\n`,
        );
        return 0;
    }

    context.stdout.write(`Local tenant configurations in ${configRoot}:\n`);
    for (const tenant of tenants) {
        context.stdout.write(
            `- ${tenant.id}${tenant.name ? ` (${tenant.name})` : ""}\n`,
        );
    }
    return 0;
}

async function createTenant(
    configRoot: string,
    parsed: ParsedArgs,
    context: CommandContext,
): Promise<number> {
    if (parsed.positionals.length > 1) {
        throw new Error(`Unexpected argument: ${parsed.positionals[1]}`);
    }

    const prompter = createPrompter(context);
    try {
        let tenantId = parsed.positionals[0];
        if (!tenantId && context.interactive === true) {
            tenantId = (await prompter.ask("Tenant ID: ")).trim();
        }
        if (!tenantId) {
            throw new Error("Tenant ID is required.");
        }
        validateTenantId(tenantId);

        const template = parseTemplate(
            readStringFlag(parsed.flags, "template") ?? "empty",
        );
        const defaultName = template === "demo" ? "Demo Tenant" : tenantId;
        const defaultDescription =
            template === "demo"
                ? "The demo tenant for the EUDI Wallet"
                : undefined;

        let name = readStringFlag(parsed.flags, "name");
        if (!name && context.interactive === true) {
            name = await promptWithDefault(
                prompter.ask,
                "Display name",
                defaultName,
            );
        }
        name ??= defaultName;

        let description = readStringFlag(parsed.flags, "description");
        if (description === undefined && context.interactive === true) {
            description = await promptOptional(
                prompter.ask,
                "Description",
                defaultDescription,
            );
        }
        description ??= defaultDescription;

        const tenantPath = join(configRoot, tenantId);
        await assertTenantTargetIsEmpty(tenantPath);
        await mkdir(tenantPath, { recursive: true, mode: 0o700 });

        if (template === "demo") {
            await copyBundledDemoConfig(tenantPath, false);
        }
        await createTenantDirectories(tenantPath);
        await writeTenantInfo(tenantPath, name, description);

        context.stdout.write(`Created tenant configuration ${tenantId}.\n`);
        context.stdout.write(`Directory: ${tenantPath}\n`);
        if (template === "demo") {
            context.stdout.write(
                "Template: demo (bundled private keys use the db provider)\n",
            );
        }
        context.stdout.write(
            `Validate with: eudiplo config validate tenant ${tenantPath}\n`,
        );
        return 0;
    } finally {
        prompter.close();
    }
}

async function removeTenant(
    configRoot: string,
    parsed: ParsedArgs,
    context: CommandContext,
): Promise<number> {
    if (parsed.positionals.length > 1) {
        throw new Error(`Unexpected argument: ${parsed.positionals[1]}`);
    }
    const tenantId = parsed.positionals[0];
    if (!tenantId) {
        throw new Error("Tenant ID is required.");
    }
    validateTenantId(tenantId);

    const tenantPath = join(configRoot, tenantId);
    if (!(await exists(join(tenantPath, "info.json")))) {
        throw new Error(`Tenant configuration not found: ${tenantId}`);
    }

    if (parsed.flags.force !== true) {
        if (context.interactive !== true) {
            throw new Error(
                "config tenant remove requires --force in non-interactive mode.",
            );
        }
        const prompter = createPrompter(context);
        try {
            const confirmed = await promptBoolean(
                prompter.ask,
                `Remove local tenant configuration ${tenantId}?`,
                false,
            );
            if (!confirmed) {
                context.stdout.write("Tenant removal cancelled.\n");
                return 0;
            }
        } finally {
            prompter.close();
        }
    }

    await rm(tenantPath, { recursive: true, force: false });
    context.stdout.write(`Removed local tenant configuration ${tenantId}.\n`);
    context.stdout.write(
        "The tenant in a running EUDIPLO instance was not deleted.\n",
    );
    return 0;
}

async function createTenantDirectories(tenantPath: string): Promise<void> {
    for (const relativeDirectory of tenantDirectories) {
        const directory = join(tenantPath, relativeDirectory);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const keepFile = join(directory, ".gitkeep");
        if (!(await exists(keepFile))) {
            await writeFile(keepFile, "", { mode: 0o600 });
        }
    }
}

async function writeTenantInfo(
    tenantPath: string,
    name: string,
    description?: string,
): Promise<void> {
    const info = description ? { name, description } : { name };
    const document = {
        $schema: "https://eudiplo.dev/schemas/v1/TenantConfigFile.schema.json",
        metadata: { generation: 1 },
        spec: info,
    };
    await writeFile(
        join(tenantPath, "info.json"),
        `${JSON.stringify(document, null, 4)}\n`,
        {
            encoding: "utf8",
            mode: 0o600,
        },
    );
}

async function assertTenantTargetIsEmpty(tenantPath: string): Promise<void> {
    try {
        const entry = await stat(tenantPath);
        if (!entry.isDirectory()) {
            throw new Error(`Tenant path points to a file: ${tenantPath}`);
        }
        if ((await readdir(tenantPath)).length > 0) {
            throw new Error(
                `Tenant configuration already exists: ${tenantPath}`,
            );
        }
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return;
        }
        throw error;
    }
}

function validateTenantId(tenantId: string): void {
    if (!TENANT_ID_PATTERN.test(tenantId)) {
        throw new Error(
            "Tenant ID must use lowercase letters, numbers, hyphens, or underscores and be at most 63 characters.",
        );
    }
}

function parseTemplate(value: string): TenantTemplate {
    if (value === "empty" || value === "demo") {
        return value;
    }
    throw new Error(
        `Unsupported --template value: ${value}. Use empty or demo.`,
    );
}

async function readTenantName(infoPath: string): Promise<string | undefined> {
    try {
        const info = JSON.parse(await readFile(infoPath, "utf8"));
        const name = info.spec?.name ?? info.name;
        return typeof name === "string" ? name : undefined;
    } catch {
        return undefined;
    }
}

function createPrompter(context: CommandContext): {
    ask: (question: string) => Promise<string>;
    close: () => void;
} {
    let promptInterface: ReturnType<typeof createInterface> | undefined;
    return {
        ask: async (question: string) => {
            if (context.prompt) {
                return context.prompt(question);
            }
            promptInterface ??= createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            return promptInterface.question(question);
        },
        close: () => promptInterface?.close(),
    };
}

async function promptWithDefault(
    prompt: (question: string) => Promise<string>,
    label: string,
    defaultValue: string,
): Promise<string> {
    const answer = (await prompt(`${label} [${defaultValue}]: `)).trim();
    return answer || defaultValue;
}

async function promptOptional(
    prompt: (question: string) => Promise<string>,
    label: string,
    defaultValue?: string,
): Promise<string | undefined> {
    const suffix = defaultValue ? ` [${defaultValue}]` : " (optional)";
    const answer = (await prompt(`${label}${suffix}: `)).trim();
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

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}
