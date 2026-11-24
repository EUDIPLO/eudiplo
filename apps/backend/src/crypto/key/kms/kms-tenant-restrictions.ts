import { isAbsolute, normalize } from "node:path";
import type { ValidationIssue } from "../../../shared/common/zod/zod-schema.util.js";
import type {
    KmsConfig,
    KmsProviderConfig,
} from "../schemas/kms-config.schema.js";
import {
    kmsPathLeavesBaseUrl,
    kmsRequestPathFields,
} from "./kms-request-path.js";

/**
 * Name of the setting that lists the files of the backend's host a tenant
 * `kms.json` may name.
 */
export const KMS_TENANT_FILES = "KMS_TENANT_FILES";

/**
 * Name of the setting that lets tenant `kms.json` files hold `aws-kms`
 * providers without credentials, which use the AWS identity of the instance.
 */
export const KMS_TENANT_AWS_DEFAULT_CREDENTIALS =
    "KMS_TENANT_AWS_DEFAULT_CREDENTIALS";

type AwsKmsProviderConfig = Extract<KmsProviderConfig, { type: "aws-kms" }>;

/**
 * Whether an `aws-kms` provider lacks credentials of its own. With only one
 * of the two values the AWS SDK also uses the default credential chain.
 */
export function usesAwsDefaultCredentials(
    provider: KmsProviderConfig,
): provider is AwsKmsProviderConfig {
    return (
        provider.type === "aws-kms" &&
        !(provider.accessKeyId && provider.secretAccessKey)
    );
}

/**
 * Matches a value that holds a `${VAR}` or `${VAR:default}` placeholder.
 * `kms.json` does not resolve the second form, but the import of a tenant
 * folder does.
 */
export const HOLDS_ENV_PLACEHOLDER = /\$\{[A-Z0-9_]+[:}]/;

/**
 * Whether the tenant's own `kms.json` (`config`) gives the tenant a provider
 * with this ID that only it can act as: the file defines the provider and
 * holds its credentials. A provider of the global file is shared by every
 * tenant. So is a provider of a tenant file that acts with something of the
 * instance: the AWS identity of the backend's environment, the client
 * certificate of mTLS files, or a value of a `${VAR}` placeholder.
 *
 * What a tenant does with its own provider concerns its own keys only. On a
 * shared provider, a key name or key ID chosen by the tenant can be a key of
 * another tenant.
 *
 * @param config the tenant file as stored, placeholders unresolved
 */
export function tenantOwnsKmsProvider(
    config: Pick<KmsConfig, "providers"> | null | undefined,
    providerId: string,
): boolean {
    const provider = (config?.providers ?? []).find(
        (candidate) => candidate.id === providerId,
    );
    if (!provider) return false;
    if (usesAwsDefaultCredentials(provider)) return false;
    if (provider.type === "http" && provider.auth?.type === "mtls") {
        return false;
    }
    return !HOLDS_ENV_PLACEHOLDER.test(JSON.stringify(provider));
}

/** What the operator allows tenant `kms.json` files to use of the instance. */
export interface TenantKmsAllowances {
    /** Files of the host, from `KMS_TENANT_FILES`. */
    files: ReadonlySet<string>;
    /** `KMS_TENANT_AWS_DEFAULT_CREDENTIALS`. */
    awsDefaultCredentials: boolean;
    /**
     * Why the outbound URL policy of the instance refuses a URL, or undefined
     * (OutboundUrlPolicyService.refusedUrl).
     */
    refusedUrl: (url: string) => string | undefined;
}

/** Codes of the issues {@link findTenantKmsRestrictionIssues} reports. */
export const KMS_TENANT_RESTRICTION_CODES: readonly string[] = [
    "refused_server_file",
    "missing_aws_credentials",
    "refused_request_path",
    "refused_outbound_url",
];

/**
 * The settings of a provider that name a server the backend sends requests
 * and the provider's credentials to, as paths relative to the provider.
 */
function kmsServerUrlFields(provider: KmsProviderConfig): string[] {
    if (provider.type === "vault") return ["vaultUrl"];
    if (provider.type === "http") {
        return provider.auth?.type === "oauth2-client-credentials"
            ? ["baseUrl", "auth.tokenUrl"]
            : ["baseUrl"];
    }
    if (provider.type === "csc") return ["baseUrl", "tokenUrl"];
    return [];
}

/**
 * The settings of a provider that name a file of the backend's host, as
 * paths relative to the provider. The backend loads a PKCS#11 `library` as
 * native code and reads the mTLS files of an `http` provider.
 */
export function kmsServerFileFields(provider: KmsProviderConfig): string[] {
    if (provider.type === "pkcs11") return ["library"];
    if (provider.type === "http" && provider.auth?.type === "mtls") {
        return ["auth.certFile", "auth.keyFile", "auth.caFile"];
    }
    return [];
}

/**
 * The files of a `KMS_TENANT_FILES` value (comma-separated absolute paths).
 *
 * @throws when an entry is not an absolute path.
 */
export function parseTenantKmsFiles(value: unknown): Set<string> {
    const paths = String(value ?? "")
        .split(",")
        .map((path) => path.trim())
        .filter(Boolean);
    for (const path of paths) {
        if (!isAbsolute(path)) {
            throw new Error(
                `${KMS_TENANT_FILES}: '${path}' is not an absolute path`,
            );
        }
    }
    return new Set(paths.map((path) => normalize(path)));
}

/** The value at `path` (keys and indexes) of `node`, or undefined. */
export function valueAtPath(
    node: unknown,
    path: ReadonlyArray<string | number>,
): unknown {
    return path.reduce<unknown>(
        (current, key) =>
            current && typeof current === "object"
                ? (current as Record<string | number, unknown>)[key]
                : undefined,
        node,
    );
}

function valueAt(node: unknown, path: string): unknown {
    return valueAtPath(node, path.split("."));
}

/**
 * What a tenant `kms.json` may not hold although the global file may. The
 * tenant's administrators can write the file through the API, so it must not
 * give them the backend's host or the instance's cloud identity:
 *
 * - A file of the host (`library` of a `pkcs11` provider, the mTLS files of
 *   an `http` provider) must be listed in `KMS_TENANT_FILES`.
 * - An `aws-kms` provider needs its own `accessKeyId` and `secretAccessKey`.
 *   Without them the AWS SDK would sign requests with the credentials of the
 *   backend's environment, which needs `KMS_TENANT_AWS_DEFAULT_CREDENTIALS`.
 * - A server ({@link kmsServerUrlFields}) must pass the outbound URL policy
 *   of the instance, like every other address a tenant chooses. Otherwise a
 *   tenant could name a KMS service of the operator's network that does not
 *   authenticate the backend, as a provider of its own, and use every key it
 *   holds.
 *
 * It also reports a path setting that leaves the provider's `baseUrl`
 * ({@link kmsPathLeavesBaseUrl}). The adapters refuse that for every file;
 * reported here, the API answers 400 before anything is stored.
 *
 * @param config the configuration with its placeholders resolved
 */
export function findTenantKmsRestrictionIssues(
    config: KmsConfig,
    allowed: TenantKmsAllowances,
): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const [index, provider] of config.providers.entries()) {
        for (const field of kmsServerFileFields(provider)) {
            const file = valueAt(provider, field);
            if (typeof file !== "string") continue;
            if (!isAbsolute(file) || !allowed.files.has(normalize(file))) {
                issues.push({
                    path: ["providers", index, ...field.split(".")],
                    message: `providers[${index}] ('${provider.id}').${field} names a file of the backend's host that is not listed in ${KMS_TENANT_FILES}, so a tenant kms.json cannot use it`,
                    code: "refused_server_file",
                });
            }
        }
        for (const field of kmsServerUrlFields(provider)) {
            const url = valueAt(provider, field);
            if (typeof url !== "string") continue;
            const reason = allowed.refusedUrl(url);
            if (reason !== undefined) {
                issues.push({
                    path: ["providers", index, ...field.split(".")],
                    message: `providers[${index}] ('${provider.id}').${field} is refused by the outbound URL policy (${reason}), which applies to the providers of a tenant kms.json`,
                    code: "refused_outbound_url",
                });
            }
        }
        for (const field of kmsRequestPathFields(provider)) {
            const path = valueAt(provider, field);
            const baseUrl = valueAt(provider, "baseUrl");
            if (
                typeof path === "string" &&
                typeof baseUrl === "string" &&
                kmsPathLeavesBaseUrl(baseUrl, path)
            ) {
                issues.push({
                    path: ["providers", index, field],
                    message: `providers[${index}] ('${provider.id}').${field} must be a path on the server of baseUrl`,
                    code: "refused_request_path",
                });
            }
        }
        if (usesAwsDefaultCredentials(provider)) {
            // One value alone is a mistake, not a choice of the default chain.
            const partial = Boolean(
                provider.accessKeyId || provider.secretAccessKey,
            );
            if (partial || !allowed.awsDefaultCredentials) {
                issues.push({
                    path: ["providers", index, "accessKeyId"],
                    message: partial
                        ? `providers[${index}] ('${provider.id}') needs accessKeyId and secretAccessKey: only one of them is set`
                        : `providers[${index}] ('${provider.id}') needs accessKeyId and secretAccessKey: an aws-kms provider of a tenant kms.json does not use the AWS credentials of the backend's environment unless ${KMS_TENANT_AWS_DEFAULT_CREDENTIALS} is set`,
                    code: "missing_aws_credentials",
                });
            }
        }
    }
    return issues;
}
