import { isSea } from "node:sea";
import { Command, CommanderError } from "commander";
import {
    createCompletionCandidatesCommand,
    createCompletionCommand,
} from "./commands/completion/index.js";
import { createCommandsCommand } from "./commands/commands/index.js";
import { createConfigCommand } from "./commands/config/index.js";
import { createDemoCommand } from "./commands/demo/index.js";
import { createDeploymentCommands } from "./commands/deployment/index.js";
import { createDoctorCommand } from "./commands/doctor/index.js";
import { createInitCommand } from "./commands/init/index.js";
import { createInstanceCommand } from "./commands/instance/index.js";
import { createOpenCommand } from "./commands/open/index.js";
import { createStatusCommand } from "./commands/status/index.js";
import { createUpgradeCommand } from "./commands/upgrade/index.js";
import { createVersionCommand, versionText } from "./commands/version/index.js";
import type { CommandContext } from "./types.js";

export async function runCli(
    args: string[],
    context: CommandContext = defaultContext(),
): Promise<number> {
    let actionExitCode = 0;
    const setExitCode = (exitCode: number): void => {
        actionExitCode = exitCode;
    };
    const program = createProgram(context, setExitCode);

    try {
        await program.parseAsync(args, { from: "user" });
        return actionExitCode;
    } catch (error) {
        if (error instanceof CommanderError) {
            return error.exitCode;
        }
        context.stderr.write(
            `${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 1;
    }
}

export function createProgram(
    context: CommandContext,
    setExitCode: (exitCode: number) => void,
): Command {
    const program = new Command()
        .name("eudiplo")
        .description("Deployment-aware command line tools for EUDIPLO")
        .version(
            versionText(),
            "-v, --version",
            "Print the installed CLI version",
        )
        .helpCommand(true)
        .addHelpText(
            "afterAll",
            "\nFor more information, see https://docs.eudiplo.dev/cookbooks/foundation",
        );

    program.addCommand(createDemoCommand(context, setExitCode));
    program.addCommand(createInitCommand(context, setExitCode));
    for (const command of createDeploymentCommands(context, setExitCode)) {
        program.addCommand(command);
    }
    program.addCommand(createUpgradeCommand(context, setExitCode));
    program.addCommand(createOpenCommand(context, setExitCode));
    program.addCommand(createInstanceCommand(context, setExitCode));
    program.addCommand(createConfigCommand(context, setExitCode));
    program.addCommand(createDoctorCommand(context, setExitCode));
    program.addCommand(createStatusCommand(context, setExitCode));
    program.addCommand(createVersionCommand(context, setExitCode));
    program.addCommand(createCompletionCommand(context, setExitCode));
    program.addCommand(
        createCompletionCandidatesCommand(context, setExitCode),
        {
            hidden: true,
        },
    );
    program.addCommand(createCommandsCommand(context, () => program));
    program.action(function showRootHelp() {
        this.outputHelp();
    });
    configureCommandTree(program, context);
    return program;
}

function configureCommandTree(command: Command, context: CommandContext): void {
    command.exitOverride();
    command.configureOutput({
        writeOut: (value) => context.stdout.write(value),
        writeErr: (value) => context.stderr.write(value),
    });
    command.showHelpAfterError("(add --help for additional information)");
    for (const child of command.commands) {
        configureCommandTree(child, context);
    }
}

function defaultContext(): CommandContext {
    return {
        cwd: process.cwd(),
        env: process.env,
        installationMethod: isSea() ? "standalone" : "npm",
        interactive:
            process.stdin.isTTY === true && process.stdout.isTTY === true,
        stdout: process.stdout,
        stderr: process.stderr,
        fetch,
    };
}
