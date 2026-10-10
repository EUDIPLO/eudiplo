import type { Command, Option } from "commander";
import type { CommandContext } from "../../types.js";
import { loadCliState } from "../shared.js";

export type CompletionShell = "bash" | "zsh" | "fish" | "powershell";

export function runCompletion(
    shell: CompletionShell,
    context: CommandContext,
): number {
    context.stdout.write(`${completionScript(shell)}\n`);
    return 0;
}

export async function runCompletionCandidates(
    root: Command,
    words: string[],
    context: CommandContext,
): Promise<number> {
    for (const candidate of await completionCandidates(root, words, context)) {
        context.stdout.write(`${candidate}\n`);
    }
    return 0;
}

function completionScript(shell: CompletionShell): string {
    switch (shell) {
        case "bash":
            return bashCompletion();
        case "zsh":
            return zshCompletion();
        case "fish":
            return fishCompletion();
        case "powershell":
            return powershellCompletion();
    }
}

async function completionCandidates(
    root: Command,
    words: string[],
    context: CommandContext,
): Promise<string[]> {
    const current = resolveCommand(root, words);
    const lastOption = findOption(current, words.at(-1));
    if (lastOption) {
        if (
            lastOption.long === "--instance" ||
            (lastOption.long === "--default" &&
                current.parent?.name() === "instance")
        ) {
            return instanceCandidates(context);
        }
        const choices = optionChoices(lastOption);
        if (choices.length > 0) {
            return choices;
        }
    }

    return staticCandidates(current, words.at(-1));
}

function resolveCommand(root: Command, words: string[]): Command {
    let current = root;
    let skipOptionValue = false;
    for (const word of words) {
        if (skipOptionValue) {
            skipOptionValue = false;
            continue;
        }
        const option = findOption(current, word);
        if (option) {
            skipOptionValue = option.required || option.optional;
            continue;
        }
        if (word.startsWith("-")) {
            continue;
        }
        const child = current.commands.find(
            (command) =>
                command.name() === word || command.aliases().includes(word),
        );
        if (child) {
            current = child;
        }
    }
    return current;
}

function staticCandidates(
    current: Command,
    lastWord: string | undefined,
): string[] {
    const candidates = ["-h", "--help"];
    for (const command of current.commands) {
        if (command.name() !== "_complete") {
            candidates.push(command.name(), ...command.aliases());
        }
    }
    for (const option of current.options) {
        if (option.short) {
            candidates.push(option.short);
        }
        if (option.long) {
            candidates.push(option.long);
        }
    }

    if (current.commands.length === 0 && lastWord === current.name()) {
        candidates.push(...(current.registeredArguments[0]?.argChoices ?? []));
    }
    return [...new Set(candidates)];
}

async function instanceCandidates(context: CommandContext): Promise<string[]> {
    try {
        const { config } = await loadCliState(context);
        return Object.keys(config.instances);
    } catch {
        return [];
    }
}

function findOption(
    command: Command,
    word: string | undefined,
): Option | undefined {
    if (!word) {
        return undefined;
    }
    const flag = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
    return command.options.find(
        (option) => option.short === flag || option.long === flag,
    );
}

function optionChoices(option: Option): string[] {
    if (option.argChoices) {
        return option.argChoices;
    }
    const placeholder = /[<[]([^>\]]+)[>\]]/u.exec(option.flags)?.[1];
    return placeholder?.includes("|") ? placeholder.split("|") : [];
}

function bashCompletion(): string {
    return [
        "_eudiplo_completion() {",
        "    local current candidates",
        "    local -a args",
        '    current="${COMP_WORDS[COMP_CWORD]}"',
        '    args=("${COMP_WORDS[@]:1:$((COMP_CWORD - 1))}")',
        '    candidates="$(eudiplo _complete "${args[@]}" 2>/dev/null)"',
        '    COMPREPLY=($(compgen -W "$candidates" -- "$current"))',
        "}",
        "complete -F _eudiplo_completion eudiplo",
    ].join("\n");
}

function zshCompletion(): string {
    return [
        "#compdef eudiplo",
        "_eudiplo() {",
        "    local -a args candidates",
        '    args=("${words[@]:2:$((CURRENT - 2))}")',
        '    candidates=("${(@f)$(eudiplo _complete "${args[@]}" 2>/dev/null)}")',
        "    compadd -- $candidates",
        "}",
        "compdef _eudiplo eudiplo",
    ].join("\n");
}

function fishCompletion(): string {
    return [
        "function __eudiplo_candidates",
        "    set -l tokens (commandline -opc)",
        "    set -e tokens[1]",
        "    eudiplo _complete $tokens 2>/dev/null",
        "end",
        "complete -c eudiplo -f -a '(__eudiplo_candidates)'",
    ].join("\n");
}

function powershellCompletion(): string {
    return [
        "Register-ArgumentCompleter -Native -CommandName eudiplo -ScriptBlock {",
        "    param($wordToComplete, $commandAst, $cursorPosition)",
        "    $arguments = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.ToString() })",
        "    if ($wordToComplete -and $arguments.Count -gt 0) {",
        "        $arguments = @($arguments | Select-Object -First ($arguments.Count - 1))",
        "    }",
        '    eudiplo _complete @arguments 2>$null | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {',
        "        [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)",
        "    }",
        "}",
    ].join("\n");
}
