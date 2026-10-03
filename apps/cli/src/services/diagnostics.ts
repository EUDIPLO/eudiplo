import type {
    CheckStatus,
    CommandContext,
    DoctorCheck,
    InstanceConfig,
} from "../types.js";
import packageJson from "../../package.json" with { type: "json" };
import {
    fetchAuthenticated,
    requestAccessToken,
    type TokenResult,
    withTrailingSlash,
} from "./api-auth.js";
import {
    compareVersions,
    readBackendVersion,
    readProviderHealth,
    summarizeProviderHealth,
} from "./backend-checks.js";
import {
    type CertificateReader,
    checkTlsCertificate,
    readPeerCertificate,
} from "./tls-expiry.js";

export type { DoctorCheck } from "../types.js";

/**
 * Everything a check may look at. `baseUrl` is undefined when the instance
 * URL cannot be parsed, which is how checks that need it declare themselves
 * skippable instead of reporting the same problem again.
 */
interface CheckContext {
    instance: InstanceConfig;
    context: CommandContext;
    baseUrl?: URL;
    now: Date;
    readCertificate: CertificateReader;
    /** Resolved once per run and shared by the authenticated checks. */
    accessToken(): Promise<TokenResult>;
}

interface DoctorCheckDefinition {
    id: string;
    run(check: CheckContext): Promise<DoctorCheck>;
}

export interface DoctorOptions {
    now?: Date;
    readCertificate?: CertificateReader;
}

export interface CheckSummary {
    pass: number;
    warn: number;
    fail: number;
    skip: number;
}

const publicUrlCheck: DoctorCheckDefinition = {
    id: "public-url",
    async run({ instance, baseUrl }) {
        if (!baseUrl) {
            return {
                name: "public URL",
                status: "fail",
                message: `${instance.url} is not a valid absolute URL`,
            };
        }
        return {
            name: "public URL",
            status: baseUrl.protocol === "https:" ? "pass" : "warn",
            message:
                baseUrl.protocol === "https:"
                    ? `${baseUrl.href} uses HTTPS`
                    : `${baseUrl.href} does not use HTTPS`,
        };
    },
};

const apiReachabilityCheck: DoctorCheckDefinition = {
    id: "api-reachability",
    run: ({ baseUrl, context }) =>
        requireBaseUrl("API reachability", baseUrl, (url) =>
            checkEndpoint("API reachability", url, "api/docs", context),
        ),
};

const healthEndpointCheck: DoctorCheckDefinition = {
    id: "health-endpoint",
    run: ({ baseUrl, context }) =>
        requireBaseUrl("health endpoint", baseUrl, (url) =>
            checkEndpoint("health endpoint", url, "health", context),
        ),
};

const tlsCertificateCheck: DoctorCheckDefinition = {
    id: "tls-certificate",
    run: ({ baseUrl, now, readCertificate }) =>
        requireBaseUrl("TLS certificate", baseUrl, (url) =>
            checkTlsCertificate(url, now, readCertificate),
        ),
};

const authenticationCheck: DoctorCheckDefinition = {
    id: "authentication",
    async run({ context }) {
        const configured =
            Boolean(context.env.EUDIPLO_CLIENT_ID) &&
            Boolean(context.env.EUDIPLO_CLIENT_SECRET);
        return {
            name: "authentication configuration",
            status: configured ? "pass" : "warn",
            message: configured
                ? "Client credentials are available in environment variables."
                : "Set EUDIPLO_CLIENT_ID and EUDIPLO_CLIENT_SECRET when commands need authenticated API access.",
        };
    },
};

const clientConnectivityCheck: DoctorCheckDefinition = {
    id: "client-connectivity",
    async run({ instance, context }) {
        if (!instance.clientUrl) {
            return {
                name: "client connectivity",
                status: "skip",
                message: "No client URL configured for this instance.",
            };
        }
        const clientUrl = parseUrl(instance.clientUrl);
        if (!clientUrl) {
            return {
                name: "client connectivity",
                status: "fail",
                message: `${instance.clientUrl} is not a valid absolute URL`,
            };
        }
        return checkEndpoint("client connectivity", clientUrl, "", context);
    },
};

const versionCompatibilityCheck: DoctorCheckDefinition = {
    id: "version-compatibility",
    run: ({ baseUrl, context, accessToken }) =>
        requireBaseUrl("version compatibility", baseUrl, async (url) => {
            const token = await accessToken();
            if (token.kind !== "token") {
                return authUnavailable("version compatibility", token);
            }
            const response = await fetchAuthenticated(
                new URL("api/version", withTrailingSlash(url)),
                token.accessToken,
                context,
            );
            if (!response.ok) {
                // A backend without /api/version (added in v4.0.0) cannot be
                // checked; that is not a failure of the deployment.
                if (response.status === 404) {
                    return {
                        name: "version compatibility",
                        status: "skip",
                        message:
                            "This backend does not expose /api/version, so compatibility cannot be checked.",
                    };
                }
                return {
                    name: "version compatibility",
                    status: "fail",
                    message: `The backend version could not be read: ${response.reason}`,
                };
            }
            const backendVersion = readBackendVersion(response.body);
            if (!backendVersion) {
                return {
                    name: "version compatibility",
                    status: "warn",
                    message: "The backend did not report a version.",
                };
            }
            return compareVersions(packageJson.version, backendVersion);
        }),
};

const kmsHealthCheck: DoctorCheckDefinition = {
    id: "kms-health",
    run: ({ baseUrl, context, accessToken }) =>
        requireBaseUrl("KMS providers", baseUrl, async (url) => {
            const token = await accessToken();
            if (token.kind !== "token") {
                return authUnavailable("KMS providers", token);
            }
            const response = await fetchAuthenticated(
                new URL(
                    "api/key-chain/providers/health",
                    withTrailingSlash(url),
                ),
                token.accessToken,
                context,
            );
            if (!response.ok) {
                // Backends before v4.5.0 have no provider health endpoint.
                if (response.status === 404) {
                    return {
                        name: "KMS providers",
                        status: "skip",
                        message:
                            "This backend does not expose the KMS provider health endpoint.",
                    };
                }
                return {
                    name: "KMS providers",
                    status: "fail",
                    message: `Provider health could not be read: ${response.reason}`,
                };
            }
            try {
                return summarizeProviderHealth(
                    readProviderHealth(response.body),
                );
            } catch {
                return {
                    name: "KMS providers",
                    status: "warn",
                    message: "The provider health response could not be read.",
                };
            }
        }),
};

/**
 * Missing credentials mean the check cannot run (skip); a token request
 * that fails is a real problem (fail).
 */
function authUnavailable(
    name: string,
    token: Exclude<TokenResult, { kind: "token" }>,
): DoctorCheck {
    return {
        name,
        status: token.kind === "unavailable" ? "skip" : "fail",
        message:
            token.kind === "unavailable"
                ? `Needs authentication: ${token.reason}.`
                : `Could not authenticate: ${token.reason}.`,
    };
}

const coreChecks: DoctorCheckDefinition[] = [
    publicUrlCheck,
    apiReachabilityCheck,
    healthEndpointCheck,
    tlsCertificateCheck,
    authenticationCheck,
    versionCompatibilityCheck,
    kmsHealthCheck,
    clientConnectivityCheck,
];

export async function runDoctor(
    instance: InstanceConfig,
    context: CommandContext,
    driverDiagnostics: DoctorCheck[],
    options: DoctorOptions = {},
): Promise<DoctorCheck[]> {
    const baseUrl = parseUrl(instance.url);
    let token: Promise<TokenResult> | undefined;
    const checkContext: CheckContext = {
        instance,
        context,
        baseUrl,
        now: options.now ?? new Date(),
        readCertificate:
            options.readCertificate ??
            context.readCertificate ??
            readPeerCertificate,
        accessToken: () => {
            if (!baseUrl) {
                return Promise.resolve({
                    kind: "unavailable",
                    reason: "the instance URL could not be parsed",
                } satisfies TokenResult);
            }
            token ??= requestAccessToken(baseUrl, context);
            return token;
        },
    };

    const checks: DoctorCheck[] = [];
    for (const check of coreChecks) {
        checks.push(await check.run(checkContext));
    }
    checks.push(...driverDiagnostics);
    return checks;
}

export function summarizeChecks(checks: DoctorCheck[]): CheckSummary {
    return {
        pass: count(checks, "pass"),
        warn: count(checks, "warn"),
        fail: count(checks, "fail"),
        skip: count(checks, "skip"),
    };
}

/**
 * Failures always count. With --strict warnings do too; skipped checks never
 * do, because a check that could not run has not found a problem.
 */
export function hasFailedChecks(
    checks: DoctorCheck[],
    strict = false,
): boolean {
    return checks.some(
        (check) =>
            check.status === "fail" || (strict && check.status === "warn"),
    );
}

export function formatChecks(checks: DoctorCheck[]): string {
    return checks
        .map(
            (check) =>
                `${formatStatus(check.status)} ${check.name}: ${check.message}`,
        )
        .join("\n");
}

export function formatSummary(summary: CheckSummary): string {
    return `${summary.pass} passed, ${summary.warn} warning(s), ${summary.fail} failure(s), ${summary.skip} skipped`;
}

function count(checks: DoctorCheck[], status: CheckStatus): number {
    return checks.filter((check) => check.status === status).length;
}

async function requireBaseUrl(
    name: string,
    baseUrl: URL | undefined,
    run: (url: URL) => Promise<DoctorCheck>,
): Promise<DoctorCheck> {
    if (!baseUrl) {
        return {
            name,
            status: "skip",
            message: "The instance URL could not be parsed.",
        };
    }
    return run(baseUrl);
}

/**
 * `path` is relative, so a path prefix in the base URL (e.g.
 * https://example.com/eudiplo) is kept, as for the authenticated checks.
 */
async function checkEndpoint(
    name: string,
    baseUrl: URL,
    path: string,
    context: CommandContext,
): Promise<DoctorCheck> {
    const url = new URL(path, withTrailingSlash(baseUrl));
    try {
        const response = await context.fetch(url, { method: "GET" });
        if (response.ok) {
            return {
                name,
                status: "pass",
                message: `${url.href} returned HTTP ${response.status}`,
            };
        }
        return {
            name,
            status: "fail",
            message: `${url.href} returned HTTP ${response.status}`,
        };
    } catch (error) {
        return {
            name,
            status: "fail",
            message: `${url.href} could not be reached: ${String(error)}`,
        };
    }
}

function parseUrl(value: string): URL | undefined {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:"
            ? url
            : undefined;
    } catch {
        return undefined;
    }
}

function formatStatus(status: CheckStatus): string {
    if (status === "pass") {
        return "PASS";
    }
    if (status === "warn") {
        return "WARN";
    }
    if (status === "skip") {
        return "SKIP";
    }
    return "FAIL";
}
