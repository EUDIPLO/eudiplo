import { readStringFlag } from "../../options.js";
import {
    assertHttpUrl,
    getInstance,
    redactUrl,
    removeInstance,
    renameInstance,
    saveConfig,
    setDefaultInstance,
    updateInstance,
    upsertInstance,
} from "../../services/cli-config.js";
import { parseTarget } from "../../services/deployment-target.js";
import {
    assertContextName,
    assertNamespace,
    defaultWorkloads,
    parseWorkloadMap,
} from "../../services/kubectl.js";
import type { CliConfig, CommandContext, ParsedArgs } from "../../types.js";

export async function runInstanceAdd(
    configPath: string,
    config: CliConfig,
    parsed: ParsedArgs,
    context: CommandContext,
): Promise<number> {
    const name = parsed.positionals[0];
    if (!name) {
        throw new Error("Instance name is required.");
    }

    const url = readStringFlag(parsed.flags, "url");
    if (!url) {
        throw new Error("--url is required.");
    }

    assertHttpUrl(url, "--url");

    const target = parseTarget(
        readStringFlag(parsed.flags, "target") ?? "external",
    );
    const clientUrl = readStringFlag(parsed.flags, "client-url");
    if (clientUrl !== undefined) {
        assertHttpUrl(clientUrl, "--client-url");
    }
    const kubernetes =
        target === "kubernetes"
            ? readKubernetesOptions(parsed.flags)
            : undefined;
    const nextConfig = upsertInstance(config, name, {
        target,
        url,
        clientUrl,
        ...kubernetes,
    });
    await saveConfig(configPath, nextConfig);
    context.stdout.write(`Added ${target} instance ${name}.\n`);
    return 0;
}

export function runInstanceList(
    config: CliConfig,
    context: CommandContext,
): number {
    const instances = Object.entries(config.instances).sort(([left], [right]) =>
        left.localeCompare(right),
    );
    if (instances.length === 0) {
        context.stdout.write("No configured instances.\n");
        return 0;
    }

    context.stdout.write("Configured instances:\n");
    for (const [name, instance] of instances) {
        const defaultLabel =
            name === config.defaultInstance ? " (default)" : "";
        context.stdout.write(
            `- ${name}${defaultLabel}: ${instance.target} ${redactUrl(instance.url)}\n`,
        );
    }
    return 0;
}

export function runInstanceShow(
    config: CliConfig,
    parsed: ParsedArgs,
    context: CommandContext,
): number {
    const name = parsed.positionals[0] ?? config.defaultInstance;
    if (!name) {
        throw new Error(
            "No instance selected. Specify a name or add an instance first.",
        );
    }
    const instance = getInstance(config, name);

    const defaultLabel = name === config.defaultInstance ? " (default)" : "";
    context.stdout.write(`Instance ${name}${defaultLabel}\n`);
    context.stdout.write(`Target: ${instance.target}\n`);
    context.stdout.write(`API URL: ${redactUrl(instance.url)}\n`);
    writeOptionalValue(
        context,
        "Client URL",
        instance.clientUrl === undefined
            ? undefined
            : redactUrl(instance.clientUrl),
    );
    writeOptionalValue(context, "Project directory", instance.projectDirectory);
    writeOptionalValue(context, "Compose file", instance.composeFile);
    writeOptionalList(context, "Compose files", instance.composeFiles);
    writeOptionalList(context, "Compose profiles", instance.composeProfiles);
    writeOptionalValue(context, "Environment file", instance.envFile);
    writeOptionalValue(context, "Project name", instance.projectName);
    writeOptionalValue(context, "Context", instance.context);
    writeOptionalValue(context, "Namespace", instance.namespace);
    if (instance.workloads) {
        const workloads = Object.entries(instance.workloads)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([service, reference]) => `${service}=${reference}`);
        writeOptionalList(context, "Workloads", workloads);
    }
    if (instance.readOnly === true) {
        context.stdout.write("Read-only: yes\n");
    }
    return 0;
}

function readKubernetesOptions(flags: ParsedArgs["flags"]): {
    context: string;
    namespace: string;
    workloads: Record<string, string>;
    readOnly?: true;
} {
    const kubeContext = readStringFlag(flags, "context");
    if (!kubeContext) {
        throw new Error("--context is required for kubernetes instances.");
    }
    const namespace = readStringFlag(flags, "namespace");
    if (!namespace) {
        throw new Error("--namespace is required for kubernetes instances.");
    }
    const workload = readStringFlag(flags, "workload");

    assertContextName(kubeContext, "--context");
    assertNamespace(namespace, "--namespace");

    return {
        context: kubeContext,
        namespace,
        workloads: workload
            ? parseWorkloadMap(workload)
            : { ...defaultWorkloads },
        readOnly: flags["read-only"] === true ? true : undefined,
    };
}

export async function runInstanceUse(
    configPath: string,
    config: CliConfig,
    parsed: ParsedArgs,
    context: CommandContext,
): Promise<number> {
    const name = requireInstanceName(parsed);
    await saveConfig(configPath, setDefaultInstance(config, name));
    context.stdout.write(`Default instance set to ${name}.\n`);
    return 0;
}

export async function runInstanceRemove(
    configPath: string,
    config: CliConfig,
    parsed: ParsedArgs,
    context: CommandContext,
): Promise<number> {
    const name = requireInstanceName(parsed);
    const newDefault = readStringFlag(parsed.flags, "default");
    const nextConfig = removeInstance(config, name, { newDefault });
    await saveConfig(configPath, nextConfig);
    context.stdout.write(`Unregistered instance ${name}.\n`);
    if (nextConfig.defaultInstance !== config.defaultInstance) {
        context.stdout.write(
            nextConfig.defaultInstance === undefined
                ? "No default instance is set.\n"
                : `Default instance set to ${nextConfig.defaultInstance}.\n`,
        );
    }
    context.stdout.write("Deployment resources were not removed.\n");
    return 0;
}

export async function runInstanceUpdate(
    configPath: string,
    config: CliConfig,
    parsed: ParsedArgs,
    context: CommandContext,
): Promise<number> {
    const name = requireInstanceName(parsed);
    const url = readStringFlag(parsed.flags, "url");
    const clientUrl =
        parsed.flags["no-client-url"] === true
            ? null
            : readStringFlag(parsed.flags, "client-url");
    await saveConfig(
        configPath,
        updateInstance(config, name, { url, clientUrl }),
    );
    context.stdout.write(`Updated instance ${name}.\n`);
    return 0;
}

export async function runInstanceRename(
    configPath: string,
    config: CliConfig,
    parsed: ParsedArgs,
    context: CommandContext,
): Promise<number> {
    const [oldName, newName] = parsed.positionals;
    if (!oldName || newName === undefined) {
        throw new Error("Old and new instance names are required.");
    }
    await saveConfig(configPath, renameInstance(config, oldName, newName));
    context.stdout.write(`Renamed instance ${oldName} to ${newName}.\n`);
    if (config.defaultInstance === oldName) {
        context.stdout.write(`Default instance is now ${newName}.\n`);
    }
    return 0;
}

function requireInstanceName(parsed: ParsedArgs): string {
    const name = parsed.positionals[0];
    if (!name) {
        throw new Error("Instance name is required.");
    }
    return name;
}

function writeOptionalValue(
    context: CommandContext,
    label: string,
    value: string | undefined,
): void {
    if (value !== undefined) {
        context.stdout.write(`${label}: ${value}\n`);
    }
}

function writeOptionalList(
    context: CommandContext,
    label: string,
    value: string[] | undefined,
): void {
    if (value !== undefined) {
        context.stdout.write(`${label}: ${value.join(", ")}\n`);
    }
}
