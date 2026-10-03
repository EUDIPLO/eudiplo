import { Argument, Command, type OptionValues } from "commander";
import type { CommandContext } from "../../types.js";
import type { SetExitCode } from "../shared.js";
import {
    type CompletionShell,
    runCompletion,
    runCompletionCandidates,
} from "./action.js";

const supportedShells: CompletionShell[] = [
    "bash",
    "zsh",
    "fish",
    "powershell",
];

export function createCompletionCommand(
    context: CommandContext,
    setExitCode: SetExitCode,
): Command {
    return new Command("completion")
        .description("Generate shell completion scripts")
        .addArgument(
            new Argument("<shell>", "shell to generate completion for").choices(
                supportedShells,
            ),
        )
        .action((shell: CompletionShell) => {
            setExitCode(runCompletion(shell, context));
        });
}

export function createCompletionCandidatesCommand(
    context: CommandContext,
    setExitCode: SetExitCode,
): Command {
    return new Command("_complete")
        .argument("[words...]")
        .allowUnknownOption(true)
        .action(
            async (
                words: string[],
                _options: OptionValues,
                command: Command,
            ) => {
                if (!command.parent) {
                    throw new Error(
                        "Completion command is not attached to the CLI root.",
                    );
                }
                setExitCode(
                    await runCompletionCandidates(
                        command.parent,
                        words,
                        context,
                    ),
                );
            },
        );
}
