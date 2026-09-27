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
 * differences are fine. Unparsable versions (e.g. "main" from a dev build)
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
    return {
        name,
        status: "pass",
        message: `CLI ${cliVersion} matches backend ${backendVersion}.`,
    };
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

function parse(
    version: string,
): { major: number; minor: number; patch: number } | undefined {
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
