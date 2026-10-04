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

/** A redacted credential was sent for a provider that has no stored value. */
export class KmsSecretNotStoredError extends Error {
    constructor(path: string) {
        super(
            `${path} is '${KMS_REDACTED_SECRET}' but the tenant KMS configuration stores no value for it; send the credential`,
        );
        this.name = "KmsSecretNotStoredError";
    }
}

function isSecretPath(path: (string | number)[]): boolean {
    return KMS_SECRET_PATHS.some((pattern) => {
        const parts = pattern.split(".");
        return (
            parts.length === path.length &&
            parts.every(
                (part, index) => part === "*" || part === `${path[index]}`,
            )
        );
    });
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
        const storedSecret =
            storedProvider?.type === provider.type
                ? path
                      .slice(2)
                      .reduce<unknown>(
                          (node, key) =>
                              node && typeof node === "object"
                                  ? (node as Record<string, unknown>)[key]
                                  : undefined,
                          storedProvider,
                      )
                : undefined;
        if (
            storedSecret === undefined ||
            storedSecret === KMS_REDACTED_SECRET
        ) {
            throw new KmsSecretNotStoredError(
                `providers[${path[1]}] ('${provider.id}').${path.slice(2).join(".")}`,
            );
        }
        return storedSecret;
    }) as KmsConfig;
}
