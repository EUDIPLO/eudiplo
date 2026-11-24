import {
    KMS_SECRET_PATHS,
    type KmsConfig,
} from "../schemas/kms-config.schema.js";
import {
    HOLDS_ENV_PLACEHOLDER,
    KMS_TENANT_AWS_DEFAULT_CREDENTIALS,
    KMS_TENANT_FILES,
    kmsServerFileFields,
    usesAwsDefaultCredentials,
} from "./kms-tenant-restrictions.js";

/**
 * Value returned instead of a credential. Sent back in an update, it keeps
 * the stored credential of the same provider.
 */
export const KMS_REDACTED_SECRET = "<redacted>";

const ENV_PLACEHOLDER = /^\$\{[A-Z0-9_]+\}$/;

/**
 * Settings that name where a credential is sent, by provider type and
 * credential path (relative to the provider, `*` for any array index). A
 * credential sent as {@link KMS_REDACTED_SECRET} is kept only while these stay
 * the same; otherwise whoever may edit the KMS configuration could send the
 * stored credential to a server of their choice without knowing it.
 *
 * `aws-kms` is not listed: the secret access key only signs requests to AWS
 * and is never sent.
 */
const CREDENTIAL_DESTINATIONS: Record<string, Record<string, string[]>> = {
    vault: { vaultToken: ["vaultUrl"] },
    pkcs11: { pin: ["library"] },
    http: {
        "auth.token": ["baseUrl"],
        "auth.clientSecret": ["auth.tokenUrl"],
    },
    csc: {
        clientSecret: ["tokenUrl"],
        sad: ["baseUrl"],
        "authorizeAuthData.*.value": ["baseUrl"],
    },
};

/** A redacted credential was sent for a provider that has no stored value. */
export class KmsSecretNotStoredError extends Error {
    constructor(path: string) {
        super(
            `${path} is '${KMS_REDACTED_SECRET}' but the tenant KMS configuration stores no value for it; send the credential`,
        );
        this.name = "KmsSecretNotStoredError";
    }
}

/** A redacted credential was sent for a provider whose destination changes. */
export class KmsSecretDestinationChangedError extends Error {
    constructor(path: string, destination: string) {
        super(
            `${path} is '${KMS_REDACTED_SECRET}' but ${destination} changes; send the credential again, a stored credential is not sent to a new address`,
        );
        this.name = "KmsSecretDestinationChangedError";
    }
}

/** An update holds a `${VAR}` placeholder the API does not accept. */
export class KmsPlaceholderRefusedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "KmsPlaceholderRefusedError";
    }
}

/** An update names a file of the backend's host the API does not accept. */
export class KmsServerFileRefusedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "KmsServerFileRefusedError";
    }
}

/** An update holds an `aws-kms` provider that would use the instance's AWS identity. */
export class KmsInstanceCredentialsRefusedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "KmsInstanceCredentialsRefusedError";
    }
}

function matches(pattern: string, path: (string | number)[]): boolean {
    const parts = pattern.split(".");
    return (
        parts.length === path.length &&
        parts.every((part, index) => part === "*" || part === `${path[index]}`)
    );
}

function isSecretPath(path: (string | number)[]): boolean {
    return KMS_SECRET_PATHS.some((pattern) => matches(pattern, path));
}

function valueAt(node: unknown, path: (string | number)[]): unknown {
    return path.reduce<unknown>(
        (current, key) =>
            current && typeof current === "object"
                ? (current as Record<string, unknown>)[key]
                : undefined,
        node,
    );
}

/** Replace the value of every credential field of `value` using `replace`. */
function mapSecrets(
    value: unknown,
    replace: (secret: unknown, path: (string | number)[]) => unknown,
    path: (string | number)[] = [],
): unknown {
    if (Array.isArray(value)) {
        return value.map((item, index) =>
            mapSecrets(item, replace, [...path, index]),
        );
    }
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value).map(([key, item]) => {
            const itemPath = [...path, key];
            return [
                key,
                isSecretPath(itemPath) && item !== undefined
                    ? replace(item, itemPath)
                    : mapSecrets(item, replace, itemPath),
            ];
        }),
    );
}

/**
 * Redact the credentials of a KMS configuration for an API response.
 *
 * @param keepEnvPlaceholders keep `${ENV_VAR}` placeholders, which name a
 * secret without containing it. Only use it for the stored, unresolved
 * configuration.
 */
export function redactKmsConfig(
    config: KmsConfig,
    { keepEnvPlaceholders }: { keepEnvPlaceholders: boolean },
): KmsConfig {
    return mapSecrets(config, (secret) =>
        keepEnvPlaceholders &&
        typeof secret === "string" &&
        ENV_PLACEHOLDER.test(secret)
            ? secret
            : KMS_REDACTED_SECRET,
    ) as KmsConfig;
}

/**
 * Replace {@link KMS_REDACTED_SECRET} in an updated configuration with the
 * stored credential at the same place of the provider with the same `id`
 * and `type`.
 *
 * @throws KmsSecretNotStoredError when there is no stored credential.
 * @throws KmsSecretDestinationChangedError when the setting that names where
 * the credential is sent changes ({@link CREDENTIAL_DESTINATIONS}).
 */
export function restoreKmsSecrets(
    update: KmsConfig,
    stored: KmsConfig | null,
): KmsConfig {
    const storedProviders = new Map(
        (stored?.providers ?? []).map((provider) => [provider.id, provider]),
    );
    return mapSecrets(update, (secret, path) => {
        if (secret !== KMS_REDACTED_SECRET) return secret;
        // path = ["providers", <index>, ...field path]
        const provider = update.providers[path[1] as number];
        const storedProvider = storedProviders.get(provider.id);
        const fieldPath = path.slice(2);
        const label = `providers[${path[1]}] ('${provider.id}').${fieldPath.join(".")}`;
        const storedSecret =
            storedProvider?.type === provider.type
                ? valueAt(storedProvider, fieldPath)
                : undefined;
        if (
            storedSecret === undefined ||
            storedSecret === KMS_REDACTED_SECRET
        ) {
            throw new KmsSecretNotStoredError(label);
        }
        const destinations = Object.entries(
            CREDENTIAL_DESTINATIONS[provider.type] ?? {},
        ).find(([pattern]) => matches(pattern, fieldPath))?.[1];
        for (const destination of destinations ?? []) {
            const destinationPath = destination.split(".");
            if (
                valueAt(provider, destinationPath) !==
                valueAt(storedProvider, destinationPath)
            ) {
                throw new KmsSecretDestinationChangedError(label, destination);
            }
        }
        return storedSecret;
    }) as KmsConfig;
}

/**
 * Refuse the `${VAR}` placeholders an update of the tenant configuration
 * brings in, anywhere in a value. A placeholder makes the backend read a
 * variable of its own environment, so only the operator, who writes the
 * tenant's `kms.json` as a file, decides which ones a tenant uses.
 *
 * A value the stored configuration already holds at the same place of the
 * provider with the same `id` and `type` is kept, as long as every setting
 * that names where the provider's credentials are sent
 * ({@link CREDENTIAL_DESTINATIONS}) stays the same.
 *
 * @throws KmsPlaceholderRefusedError
 */
export function assertNoNewKmsPlaceholders(
    update: KmsConfig,
    stored: KmsConfig | null,
): void {
    const storedProviders = new Map(
        (stored?.providers ?? []).map((provider) => [provider.id, provider]),
    );
    const refuse = (label: string): never => {
        throw new KmsPlaceholderRefusedError(
            `${label} holds a \${VAR} placeholder. The API does not accept placeholders in a tenant KMS configuration; send the value, or have the operator write the placeholder to the tenant's kms.json`,
        );
    };
    const visit = (value: unknown, path: (string | number)[]): void => {
        if (Array.isArray(value)) {
            value.forEach((item, index) => visit(item, [...path, index]));
            return;
        }
        if (value && typeof value === "object") {
            for (const [key, item] of Object.entries(value)) {
                visit(item, [...path, key]);
            }
            return;
        }
        if (typeof value !== "string" || !HOLDS_ENV_PLACEHOLDER.test(value)) {
            return;
        }
        if (path[0] !== "providers" || typeof path[1] !== "number") {
            if (valueAt(stored, path) !== value) refuse(path.join("."));
            return;
        }
        // path = ["providers", <index>, ...field path]
        const provider = update.providers[path[1]];
        const storedProvider = storedProviders.get(provider.id);
        const fieldPath = path.slice(2);
        const label = `providers[${path[1]}] ('${provider.id}').${fieldPath.join(".")}`;
        if (
            storedProvider?.type !== provider.type ||
            valueAt(storedProvider, fieldPath) !== value
        ) {
            refuse(label);
        }
        const destinations = new Set(
            Object.values(CREDENTIAL_DESTINATIONS[provider.type] ?? {}).flat(),
        );
        for (const destination of destinations) {
            const destinationPath = destination.split(".");
            if (
                valueAt(provider, destinationPath) !==
                valueAt(storedProvider, destinationPath)
            ) {
                throw new KmsPlaceholderRefusedError(
                    `${label} keeps a stored \${VAR} placeholder but ${destination} changes; send the value, a stored placeholder is not sent to a new address`,
                );
            }
        }
    };
    visit(update, []);
}

/**
 * Refuse the files of the backend's host an update of the tenant
 * configuration brings in: the `library` of a `pkcs11` provider, which the
 * backend loads as native code, and the mTLS files of an `http` provider.
 * Only the operator, who writes the tenant's `kms.json` as a file and lists
 * its files in `KMS_TENANT_FILES`, decides which ones a tenant uses; every
 * tenant could otherwise use every listed file.
 *
 * A path the stored configuration already holds in the same setting of the
 * provider with the same `id` and `type` is kept. For an `http` provider the
 * `baseUrl` must stay the same too, so a stored client certificate is not
 * presented to another server.
 *
 * @throws KmsServerFileRefusedError
 */
export function assertNoNewKmsServerFiles(
    update: KmsConfig,
    stored: KmsConfig | null,
): void {
    const storedProviders = new Map(
        (stored?.providers ?? []).map((provider) => [provider.id, provider]),
    );
    for (const [index, provider] of update.providers.entries()) {
        const storedProvider = storedProviders.get(provider.id);
        for (const field of kmsServerFileFields(provider)) {
            const fieldPath = field.split(".");
            const file = valueAt(provider, fieldPath);
            if (file === undefined) continue;
            const label = `providers[${index}] ('${provider.id}').${field}`;
            if (
                storedProvider?.type !== provider.type ||
                valueAt(storedProvider, fieldPath) !== file
            ) {
                throw new KmsServerFileRefusedError(
                    `${label} names a file of the backend's host. The API does not accept such a path in a tenant KMS configuration; have the operator write it to the tenant's kms.json and list it in ${KMS_TENANT_FILES}`,
                );
            }
            if (
                provider.type === "http" &&
                valueAt(storedProvider, ["baseUrl"]) !== provider.baseUrl
            ) {
                throw new KmsServerFileRefusedError(
                    `${label} keeps a stored file but baseUrl changes; a stored client certificate is not used for a new address`,
                );
            }
        }
    }
}

/**
 * Refuse the `aws-kms` providers without credentials an update of the tenant
 * configuration brings in. Such a provider calls AWS KMS with the identity of
 * the instance, so only the operator, who writes the tenant's `kms.json` as a
 * file and sets `KMS_TENANT_AWS_DEFAULT_CREDENTIALS`, decides which tenant
 * gets one; every tenant could otherwise add it.
 *
 * A provider the stored configuration already holds without credentials,
 * with the same `id` and `region`, is kept.
 *
 * @throws KmsInstanceCredentialsRefusedError
 */
export function assertNoNewKmsInstanceCredentials(
    update: KmsConfig,
    stored: KmsConfig | null,
): void {
    const storedProviders = new Map(
        (stored?.providers ?? []).map((provider) => [provider.id, provider]),
    );
    for (const [index, provider] of update.providers.entries()) {
        if (!usesAwsDefaultCredentials(provider)) continue;
        const storedProvider = storedProviders.get(provider.id);
        if (
            !storedProvider ||
            !usesAwsDefaultCredentials(storedProvider) ||
            storedProvider.region !== provider.region
        ) {
            throw new KmsInstanceCredentialsRefusedError(
                `providers[${index}] ('${provider.id}') needs accessKeyId and secretAccessKey. The API does not accept an aws-kms provider that uses the AWS credentials of the backend's environment; send credentials, or have the operator write the provider to the tenant's kms.json and set ${KMS_TENANT_AWS_DEFAULT_CREDENTIALS}`,
            );
        }
    }
}
