import { isSea } from "node:sea";
import packageJson from "../../../package.json" with { type: "json" };
import type { CommandContext } from "../../types.js";

export function versionText(): string {
    return `${packageJson.name} ${packageJson.version}`;
}

export async function versionStatusText(
    context: CommandContext,
): Promise<string> {
    const currentVersion = packageJson.version;
    const lines = [versionText()];

    try {
        const latestVersion = await fetchLatestVersion(context);
        lines.push(`latest ${latestVersion}`);
        const comparison = compareSemver(currentVersion, latestVersion);
        if (comparison < 0) {
            lines.push(`update available: ${updateCommand(context)}`);
        } else if (comparison === 0) {
            lines.push("up to date");
        } else {
            lines.push("newer than the latest published version");
        }
    } catch (error) {
        lines.push(
            `latest unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    return lines.join("\n");
}

function updateCommand(context: CommandContext): string {
    const installationMethod =
        context.installationMethod ?? (isSea() ? "standalone" : "npm");
    return installationMethod === "standalone"
        ? "curl -fsSL https://eudiplo.dev/install.sh | bash"
        : "npm install -g @eudiplo/cli@latest";
}

async function fetchLatestVersion(context: CommandContext): Promise<string> {
    const response = await context.fetch(
        `https://registry.npmjs.org/${encodeURIComponent(packageJson.name)}/latest`,
    );
    if (!response.ok) {
        throw new Error(`npm registry returned HTTP ${response.status}`);
    }

    const metadata = await response.json();
    if (!isPackageMetadata(metadata)) {
        throw new Error("npm registry response did not include a version");
    }
    return metadata.version;
}

function isPackageMetadata(value: unknown): value is { version: string } {
    return (
        typeof value === "object" &&
        value !== null &&
        "version" in value &&
        typeof value.version === "string"
    );
}

function compareSemver(left: string, right: string): number {
    const leftParts = parseSemver(left);
    const rightParts = parseSemver(right);

    for (let index = 0; index < leftParts.length; index += 1) {
        if (leftParts[index] > rightParts[index]) {
            return 1;
        }
        if (leftParts[index] < rightParts[index]) {
            return -1;
        }
    }
    return 0;
}

function parseSemver(version: string): [number, number, number] {
    const [major = "0", minor = "0", patch = "0"] = version
        .split("-", 1)[0]
        .split(".");
    return [Number(major) || 0, Number(minor) || 0, Number(patch) || 0];
}
