import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readStringFlag } from "../../options.js";
import {
    buildComposePullArgs,
    buildComposeUpArgs,
} from "../../services/compose-args.js";
import {
    managedServices,
    migrationNotes,
    planImageUpgrade,
} from "../../services/compose-upgrade.js";
import {
    assertWritable,
    runCompose,
    unsupportedCommand,
} from "../../services/deployment-drivers.js";
import { resolveInstance } from "../../services/instance-selection.js";
import type {
    CliConfig,
    CommandContext,
    DriverCommandOptions,
    ParsedArgs,
} from "../../types.js";
import { createPrompter } from "../shared.js";

export async function runUpgradeCommand(
    config: CliConfig,
    parsed: ParsedArgs,
    context: CommandContext,
): Promise<number> {
    const [instanceName, instance] = resolveInstance(config, parsed);
    if (instance.target !== "compose") {
        throw new Error(unsupportedCommand("upgrade", instance.target));
    }
    const options: DriverCommandOptions = {
        instanceName,
        instance,
        args: [],
        flags: parsed.flags,
        context,
    };
    assertWritable(options);

    const tag = readStringFlag(parsed.flags, "image-tag");
    if (!tag) {
        throw new Error("upgrade requires --image-tag <tag>.");
    }
    if (!instance.envFile) {
        throw new Error(
            `Instance ${instanceName} has no env file, so its images are not managed by the CLI.`,
        );
    }
    const envPath = resolve(
        instance.projectDirectory ?? context.cwd,
        instance.envFile,
    );
    const original = await readEnvFile(envPath);
    const plan = planImageUpgrade(original, tag);

    if (plan.changes.length === 0) {
        context.stdout.write(
            `${instanceName} already uses image tag ${tag}.\n`,
        );
        return 0;
    }

    context.stdout.write(`Upgrade ${instanceName}:\n`);
    for (const change of plan.changes) {
        context.stdout.write(
            change.movedFrom
                ? `  ${change.movedFrom}:${change.from} -> ${change.repository}:${change.to}\n`
                : `  ${change.repository}: ${change.from} -> ${change.to}\n`,
        );
    }
    const notes = new Set(
        plan.changes.flatMap((change) =>
            migrationNotes(change.from, change.to),
        ),
    );
    for (const note of notes) {
        context.stdout.write(`Note: ${note}\n`);
    }

    if (!(await confirmUpgrade(parsed, context))) {
        context.stdout.write("Upgrade cancelled. Nothing was changed.\n");
        return 0;
    }

    // Writing to the existing path keeps its owner-only permissions.
    await writeFile(envPath, plan.content, "utf8");

    // Pull only the images this upgrade changes. The other services keep
    // their images, and a registry that stopped serving one of them (MinIO's
    // images now need a login) must not block the upgrade.
    const pulled = await runCompose(
        buildComposePullArgs(
            plan.changes.map((change) => managedServices[change.key]),
        ),
        options,
    );
    if (pulled !== 0) {
        await writeFile(envPath, original, "utf8");
        context.stderr.write(
            `Pulling the new images failed. Restored the previous image tags in ${envPath}.\n`,
        );
        return pulled;
    }

    const recreated = await runCompose(buildComposeUpArgs(), options);
    if (recreated !== 0) {
        context.stderr.write(
            `The new images were pulled and ${envPath} now uses ${tag}, but recreating the services failed. Fix the error above and run eudiplo up.\n`,
        );
        return recreated;
    }

    context.stdout.write(`Upgraded ${instanceName} to ${tag}.\n`);
    return 0;
}

async function readEnvFile(path: string): Promise<string> {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
        ) {
            throw new Error(`Env file not found: ${path}`);
        }
        throw error;
    }
}

async function confirmUpgrade(
    parsed: ParsedArgs,
    context: CommandContext,
): Promise<boolean> {
    if (parsed.flags.yes === true) {
        return true;
    }
    if (context.interactive !== true) {
        throw new Error("upgrade requires --yes in non-interactive mode.");
    }
    const prompter = createPrompter(context);
    try {
        const answer = (await prompter.ask("Continue? [y/N]: "))
            .trim()
            .toLowerCase();
        return answer === "y" || answer === "yes";
    } finally {
        prompter.close();
    }
}
