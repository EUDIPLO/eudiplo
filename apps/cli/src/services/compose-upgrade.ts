/**
 * Application upgrades for Compose instances.
 *
 * The CLI manages exactly two lines in the instance env file:
 * EUDIPLO_IMAGE and EUDIPLO_CLIENT_IMAGE, pointing at the official images.
 * An upgrade rewrites the tag on those lines and nothing else: every other
 * byte of the file, including comments, ordering, user keys and line
 * endings, is kept as it was.
 */

const managedImages = {
    EUDIPLO_IMAGE: "ghcr.io/eudiplo/eudiplo",
    EUDIPLO_CLIENT_IMAGE: "ghcr.io/eudiplo/eudiplo-client",
} as const;

type ManagedKey = keyof typeof managedImages;

/** The Compose service that runs the image of each managed line. */
export const managedServices: Record<ManagedKey, string> = {
    EUDIPLO_IMAGE: "eudiplo",
    EUDIPLO_CLIENT_IMAGE: "eudiplo-client",
};

// Releases up to v8.1.0 were published while the project was hosted by the
// OpenWallet Foundation. Instances still on those images are moved to the
// current repository by their next upgrade.
const legacyImages: Record<ManagedKey, string> = {
    EUDIPLO_IMAGE: "ghcr.io/openwallet-foundation/eudiplo",
    EUDIPLO_CLIENT_IMAGE: "ghcr.io/openwallet-foundation/eudiplo-client",
};

interface ImageChange {
    key: ManagedKey;
    repository: string;
    /** The legacy repository the line pointed at, when it is being moved. */
    movedFrom?: string;
    from: string;
    to: string;
}

interface UpgradePlan {
    changes: ImageChange[];
    /** The env file with only the managed tags replaced. */
    content: string;
}

// OCI tag grammar: up to 128 characters, no leading "." or "-".
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export function assertImageTag(tag: string): void {
    if (!TAG.test(tag)) {
        throw new Error(
            `Invalid image tag ${JSON.stringify(tag)}. Tags contain letters, digits, "_", "." and "-", and cannot start with "." or "-".`,
        );
    }
}

/** Returns the tag of `value` if it is `repository:<tag>`. */
function tagOf(value: string, repository: string): string | undefined {
    const prefix = `${repository}:`;
    if (!value.startsWith(prefix)) {
        return undefined;
    }
    const tag = value.slice(prefix.length);
    return TAG.test(tag) ? tag : undefined;
}

/**
 * Plans a tag change for the managed image lines. Lines on a legacy
 * repository are moved to the current one. Refuses rather than guesses when
 * a line has been customised (another registry, a digest, or no tag),
 * because that line is then user-managed.
 */
export function planImageUpgrade(content: string, tag: string): UpgradePlan {
    assertImageTag(tag);

    const found = new Set<ManagedKey>();
    const changes: ImageChange[] = [];
    // Split on "\n" only, so "\r" stays attached to its line and CRLF files
    // are written back with CRLF.
    const lines = content.split("\n").map((line) => {
        const match = /^(EUDIPLO_IMAGE|EUDIPLO_CLIENT_IMAGE)=(.*?)(\r?)$/.exec(
            line,
        );
        if (!match) {
            return line;
        }
        const key = match[1] as ManagedKey;
        const value = match[2];
        const lineEnding = match[3];
        const repository = managedImages[key];

        if (found.has(key)) {
            throw new Error(
                `${key} is defined more than once in the env file.`,
            );
        }
        found.add(key);

        const currentTag = tagOf(value, repository);
        const legacyTag = tagOf(value, legacyImages[key]);
        const current = currentTag ?? legacyTag;
        if (current === undefined) {
            throw new Error(
                `${key} is set to ${value}, which is not a CLI-managed image. Update it yourself, or restore ${repository}:<tag> to let the CLI manage it.`,
            );
        }

        if (currentTag === undefined) {
            changes.push({
                key,
                repository,
                movedFrom: legacyImages[key],
                from: current,
                to: tag,
            });
        } else if (current !== tag) {
            changes.push({ key, repository, from: current, to: tag });
        }
        return `${key}=${repository}:${tag}${lineEnding}`;
    });

    if (!found.has("EUDIPLO_IMAGE")) {
        throw new Error(
            "The env file does not define EUDIPLO_IMAGE, so there is no CLI-managed image to upgrade.",
        );
    }

    return { changes, content: lines.join("\n") };
}

interface Version {
    major: number;
    minor: number;
    patch: number;
}

function parseVersion(tag: string): Version | undefined {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
    if (!match) {
        return undefined;
    }
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
    };
}

function compareVersions(a: Version, b: Version): number {
    return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

const migrationBaseUrl = "https://docs.eudiplo.dev/upgrade";

/**
 * Notes to show before an upgrade: the migration guide for every major
 * version crossed, a downgrade warning, or a pointer to the guide index when
 * the tags are not plain versions (e.g. "latest").
 */
export function migrationNotes(from: string, to: string): string[] {
    const fromVersion = parseVersion(from);
    const toVersion = parseVersion(to);

    if (!fromVersion || !toVersion) {
        return [
            `Cannot compare ${from} and ${to} as versions. Check the release notes and ${migrationBaseUrl} before continuing.`,
        ];
    }

    const order = compareVersions(fromVersion, toVersion);
    if (order > 0) {
        return [
            `${to} is older than ${from}. Downgrades are not supported once database migrations have run; restore a backup instead if you need to go back.`,
        ];
    }

    const notes: string[] = [];
    for (let major = fromVersion.major + 1; major <= toVersion.major; major++) {
        notes.push(
            `Major version ${major}: read ${migrationBaseUrl}/${major - 1}.x-to-${major}.0 first.`,
        );
    }
    return notes;
}
