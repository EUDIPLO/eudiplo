import type { CliInstallationMethod } from "./types.js";

export function detectInstallationMethod({
    env,
    scriptPath,
    isSea,
}: {
    env: NodeJS.ProcessEnv;
    scriptPath: string | undefined;
    isSea: boolean;
}): CliInstallationMethod {
    // Checked first: the binary may be started from a shell that inherited npm_command.
    if (isSea) return "standalone";
    // Set by npm itself for `npx` and `npm exec`; `npm run` sets "run-script" instead.
    if (env.npm_command === "exec") return "npx";
    // Fallback if the variable is missing. The `_npx` cache directory is an npm
    // implementation detail, so it only counts as a whole path segment.
    if (scriptPath && /[\\/]_npx[\\/]/.test(scriptPath)) return "npx";
    return "npm";
}
