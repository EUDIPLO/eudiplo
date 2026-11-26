import type { DoctorCheck } from "../types.js";

export interface ProviderHealth {
    providerId: string;
    type: string;
    ok: boolean;
    latencyMs?: number;
    error?: string;
}

/**
 * Compares the CLI version with the backend version. A different major
 * version is a failure, a different minor version a warning; patch
 * differences are fine, except for a CLI after a backend that predates the
 * escaped form ({@link LAST_RELEASE_WITHOUT_ESCAPED_FORM}). Unparsable versions (e.g. "main" from a dev build)
 * cannot be judged, so they warn rather than fail.
 */
export function compareVersions(
    cliVersion: string,
    backendVersion: string,
): DoctorCheck {
    const name = "version compatibility";
    const cli = parse(cliVersion);
    const backend = parse(backendVersion);

    if (!cli || !backend) {
        return {
            name,
            status: "warn",
            message: `CLI ${cliVersion} and backend ${backendVersion} cannot be compared as versions.`,
        };
    }
    if (cli.major !== backend.major) {
        return {
            name,
            status: "fail",
            message: `CLI ${cliVersion} and backend ${backendVersion} are different major versions. Install a matching CLI with npm install -g @eudiplo/cli@${backend.major}.`,
        };
    }
    if (cli.minor !== backend.minor) {
        return {
            name,
            status: "warn",
            message: `CLI ${cliVersion} and backend ${backendVersion} differ in minor version; some commands may not be supported.`,
        };
    }
    if (
        compare(cli, LAST_RELEASE_WITHOUT_ESCAPED_FORM) > 0 &&
        compare(backend, LAST_RELEASE_WITHOUT_ESCAPED_FORM) <= 0
    ) {
        return {
            name,
            status: "warn",
            message: `CLI ${cliVersion} and backend ${backendVersion} read the escaped form $\${ of configuration files differently; config plan and import of a tenant folder store values containing \${ or $\${ differently. Upgrade the backend to match the CLI.`,
        };
    }
    return {
        name,
        status: "pass",
        message: `CLI ${cliVersion} matches backend ${backendVersion}.`,
    };
}

/**
 * The last release whose backend does not know the escaped form `$${` of
 * configuration files. The form came with the first release after this one,
 * whichever number that release got.
 */
const LAST_RELEASE_WITHOUT_ESCAPED_FORM: Version = {
    major: 10,
    minor: 1,
    patch: 0,
};

/**
 * A warning for `config plan`/`import` of a tenant folder when the backend
 * predates the escaped form: this CLI sends `$${` as it is and escapes the
 * values it fills in, which such a backend stores as they are. Undefined for
 * a backend that knows the form, or whose version is unknown or cannot be
 * compared (a development build reports "main").
 */
export function escapedFormWarning(
    backendVersion: string | undefined,
): string | undefined {
    const backend = backendVersion ? parse(backendVersion) : undefined;
    if (!backend || compare(backend, LAST_RELEASE_WITHOUT_ESCAPED_FORM) > 0)
        return undefined;
    return `Warning: the backend (${backendVersion}) does not read the escaped form $\${ of configuration files, which this CLI sends: values containing \${ or $\${ will be stored differently from what the files say. Upgrade the CLI and the backend together.`;
}

function compare(left: Version, right: Version): number {
    return (
        left.major - right.major ||
        left.minor - right.minor ||
        left.patch - right.patch
    );
}

export function readBackendVersion(body: unknown): string | undefined {
    if (typeof body === "object" && body !== null && "version" in body) {
        const version = (body as { version: unknown }).version;
        return typeof version === "string" && version ? version : undefined;
    }
    return undefined;
}

export function readProviderHealth(body: unknown): ProviderHealth[] {
    if (!Array.isArray(body)) {
        throw new Error("the provider health response was not a list");
    }
    return body.map((entry) => {
        const record = entry as Record<string, unknown>;
        return {
            providerId: String(record.providerId ?? "unknown"),
            type: String(record.type ?? "unknown"),
            ok: record.ok === true,
            latencyMs:
                typeof record.latencyMs === "number"
                    ? record.latencyMs
                    : undefined,
            error: typeof record.error === "string" ? record.error : undefined,
        };
    });
}

/**
 * Summarizes KMS provider health. Provider errors are reported by provider
 * id and type only; the raw error text is not echoed, since it can contain
 * endpoint details or credentials.
 */
export function summarizeProviderHealth(
    providers: ProviderHealth[],
): DoctorCheck {
    const name = "KMS providers";
    if (providers.length === 0) {
        return {
            name,
            status: "warn",
            message: "No KMS providers are registered for this tenant.",
        };
    }

    const failing = providers.filter((provider) => !provider.ok);
    if (failing.length > 0) {
        return {
            name,
            status: "fail",
            message: `${failing.length}/${providers.length} provider(s) unhealthy: ${failing
                .map(
                    (provider) =>
                        `${provider.providerId} (${provider.type})${provider.error ? ", health check reported an error" : ""}`,
                )
                .join(", ")}`,
        };
    }

    return {
        name,
        status: "pass",
        message: `${providers.length} provider(s) healthy: ${providers
            .map(
                (provider) =>
                    `${provider.providerId} (${provider.type}${provider.latencyMs === undefined ? "" : `, ${provider.latencyMs}ms`})`,
            )
            .join(", ")}`,
    };
}

interface Version {
    major: number;
    minor: number;
    patch: number;
}

function parse(version: string): Version | undefined {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
    if (!match) {
        return undefined;
    }
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
    };
}
