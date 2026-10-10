import {
    KMS_SECRET_PATHS,
    type KmsConfig,
} from "../schemas/kms-config.schema.js";

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
