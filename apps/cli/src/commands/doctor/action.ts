import { drivers } from "../../services/deployment-drivers.js";
import {
    type DoctorOptions,
    formatChecks,
    formatSummary,
    hasFailedChecks,
    runDoctor,
    summarizeChecks,
} from "../../services/diagnostics.js";
import { resolveInstance } from "../../services/instance-selection.js";
import type {
    CliConfig,
    CommandContext,
    DoctorCheck,
    ParsedArgs,
} from "../../types.js";

export async function runDoctorCommand(
    config: CliConfig,
    parsed: ParsedArgs,
    context: CommandContext,
    options: DoctorOptions = {},
): Promise<number> {
    const strict = parsed.flags.strict === true;
    const instances =
        parsed.flags.all === true
            ? Object.keys(config.instances)
            : [resolveInstance(config, parsed)[0]];

    if (instances.length === 0) {
        throw new Error("No instances are configured.");
    }

    let failed = false;
    for (const [index, instanceName] of instances.entries()) {
        const instance = config.instances[instanceName];
        if (index > 0) {
            context.stdout.write("\n");
        }
        const checks = await runDiagnostics(instance, context, options);
        context.stdout.write(
            `Doctor for ${instanceName} (${instance.target})\n`,
        );
        context.stdout.write(`${formatChecks(checks)}\n`);
        context.stdout.write(`${formatSummary(summarizeChecks(checks))}\n`);
        failed = hasFailedChecks(checks, strict) || failed;
    }

    return failed ? 1 : 0;
}

async function runDiagnostics(
    instance: CliConfig["instances"][string],
    context: CommandContext,
    options: DoctorOptions,
): Promise<DoctorCheck[]> {
    const driver = drivers[instance.target];
    return runDoctor(
        instance,
        context,
        await driver.diagnostics(instance, context),
        options,
    );
}
