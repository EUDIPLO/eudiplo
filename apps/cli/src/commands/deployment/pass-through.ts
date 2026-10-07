import type { Command } from "commander";

/**
 * The driver commands pass the options they do not define to Compose or
 * kubectl, as in `eudiplo down --volumes`. Commander then no longer rejects a
 * misspelled option of the command itself, which would reach the runtime
 * while the command acts on the default instance. An unknown option within
 * two edits of one of the command's options is rejected here instead, with
 * the message Commander gives for unknown options of other commands. No
 * Compose or kubectl flag is that close to an option of these commands.
 *
 * Commander drops a leading "--" but keeps one that follows an unknown
 * option. That one is dropped here, so "--" never reaches the runtime.
 */
export function runtimeArguments(command: Command, args: string[]): string[] {
    const options = command.options.flatMap((option) => option.long ?? []);
    for (const arg of args) {
        if (!arg.startsWith("--") || arg === "--") {
            continue;
        }
        const flag = arg.split("=", 1)[0];
        const similar = options.filter(
            (option) => option !== flag && editDistance(flag, option) <= 2,
        );
        if (similar.length > 0) {
            const suggestion =
                similar.length === 1
                    ? similar[0]
                    : `one of ${similar.join(", ")}`;
            command.error(
                `error: unknown option '${arg}'\n(Did you mean ${suggestion}?)`,
                { code: "commander.unknownOption" },
            );
        }
    }
    const separator = args.indexOf("--");
    return separator === -1
        ? args
        : [...args.slice(0, separator), ...args.slice(separator + 1)];
}

/**
 * Optimal string alignment distance: insertions, deletions, substitutions
 * and swaps of adjacent characters, as in Commander's own suggestions.
 */
function editDistance(a: string, b: string): number {
    const distances = Array.from({ length: a.length + 1 }, (_, i) =>
        Array.from({ length: b.length + 1 }, (_, j) => Math.max(i, j)),
    );
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            distances[i][j] = Math.min(
                distances[i - 1][j] + 1,
                distances[i][j - 1] + 1,
                distances[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
            if (
                i > 1 &&
                j > 1 &&
                a[i - 1] === b[j - 2] &&
                a[i - 2] === b[j - 1]
            ) {
                distances[i][j] = Math.min(
                    distances[i][j],
                    distances[i - 2][j - 2] + 1,
                );
            }
        }
    }
    return distances[a.length][b.length];
}
