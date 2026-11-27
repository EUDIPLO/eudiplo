import packageJson from "../../../package.json" with { type: "json" };
import type { CliInstallationMethod, CommandContext } from "../../types.js";

export function versionText(): string {
    return `${packageJson.name} ${packageJson.version}`;
}

export async function versionStatusText(
    context: CommandContext,
): Promise<string> {
    const currentVersion = packageJson.version;
    const lines = [versionText()];

    try {
        const source = updateSource(context);
        const latestVersion = await source.fetchLatest(context);
        lines.push(`latest ${latestVersion}`);
        const comparison = compareSemver(currentVersion, latestVersion);
        if (comparison < 0) {
            lines.push(`update available: ${source.updateHint}`);
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

const GITHUB_LATEST_RELEASE =
    "https://api.github.com/repos/EUDIPLO/eudiplo/releases/latest";

/** Where each installation method looks up the latest version, and how it updates. */
const updateSources: Record<
    CliInstallationMethod,
    {
        fetchLatest: (context: CommandContext) => Promise<string>;
        updateHint: string;
    }
> = {
    npm: {
        fetchLatest: fetchLatestVersionForNpm,
        updateHint: "npm install -g @eudiplo/cli@latest",
    },
    npx: {
        fetchLatest: fetchLatestVersionForNpm,
        updateHint: "npx @eudiplo/cli@latest",
    },
    standalone: {
        fetchLatest: fetchLatestVersionForStandalone,
        updateHint: "curl -fsSL https://eudiplo.dev/install.sh | bash",
    },
    "windows-archive": {
        fetchLatest: fetchLatestVersionForStandalone,
        updateHint:
            "download the Windows archive from https://github.com/EUDIPLO/eudiplo/releases/latest",
    },
};

function updateSource(context: CommandContext) {
    const source = updateSources[context.installationMethod];
    if (!source) {
        throw new Error(
            `unknown installation method ${JSON.stringify(context.installationMethod)}`,
        );
    }
    return source;
}

async function fetchLatestVersionForNpm(
    context: CommandContext,
): Promise<string> {
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

async function fetchLatestVersionForStandalone(
    context: CommandContext,
): Promise<string> {
    const response = await context.fetch(GITHUB_LATEST_RELEASE, {
        headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) {
        throw new Error(`GitHub releases returned HTTP ${response.status}`);
    }

    const release = await response.json();
    if (!isReleaseMetadata(release)) {
        throw new Error("GitHub release response did not include a tag_name");
    }
    return release.tag_name.replace(/^v/, "");
}

function isPackageMetadata(value: unknown): value is { version: string } {
    return (
        typeof value === "object" &&
        value !== null &&
        "version" in value &&
        typeof value.version === "string"
    );
}

function isReleaseMetadata(value: unknown): value is { tag_name: string } {
    return (
        typeof value === "object" &&
        value !== null &&
        "tag_name" in value &&
        typeof value.tag_name === "string"
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
