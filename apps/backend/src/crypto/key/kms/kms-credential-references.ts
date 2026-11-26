import type {
    SecretScope,
    SecretUse,
} from "../../../platform/secrets/domain/secret-use.js";
import {
    KMS_SECRET_PATHS,
    type KmsProviderConfig,
} from "../schemas/kms-config.schema.js";

/**
 * Settings that name where a credential is sent, by provider type and
 * credential path (relative to the provider, `*` for any array index). A
 * credential kept as `<redacted>` must keep these, and a secret reference
 * bound to origins is checked against them.
 *
 * `aws-kms` is not listed: the secret access key only signs requests to AWS
 * and is never sent ({@link kmsCredentialUse} names the region's endpoint).
 */
export const KMS_CREDENTIAL_DESTINATIONS: Record<
    string,
    Record<string, string[]>
> = {
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

/** A credential of a provider: its path below the provider, and its value. */
export interface KmsCredential {
    path: (string | number)[];
    value: string;
}

function matches(pattern: string, path: (string | number)[]): boolean {
    const parts = pattern.split(".");
    return (
        parts.length === path.length &&
        parts.every((part, index) => part === "*" || part === `${path[index]}`)
    );
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

/** Every credential of `provider` that holds a string ({@link KMS_SECRET_PATHS}). */
export function kmsCredentials(provider: KmsProviderConfig): KmsCredential[] {
    const found: KmsCredential[] = [];
    const visit = (node: unknown, path: (string | number)[]): void => {
        if (typeof node === "string") {
            if (
                KMS_SECRET_PATHS.some((pattern) =>
                    matches(pattern, ["providers", 0, ...path]),
                )
            )
                found.push({ path, value: node });
            return;
        }
        if (Array.isArray(node)) {
            node.forEach((item, index) => visit(item, [...path, index]));
            return;
        }
        if (node && typeof node === "object")
            for (const [key, item] of Object.entries(node))
                visit(item, [...path, key]);
    };
    visit(provider, []);
    return found;
}

/** `provider` with the credential at `path` replaced by `value`. */
export function withCredential<T>(
    provider: T,
    path: (string | number)[],
    value: string,
): T {
    const [key, ...rest] = path;
    if (key === undefined) return value as T;
    if (Array.isArray(provider)) {
        return provider.map((item, index) =>
            index === key ? withCredential(item, rest, value) : item,
        ) as T;
    }
    const node = (provider ?? {}) as Record<string, unknown>;
    return {
        ...node,
        [key]: withCredential(node[key as string], rest, value),
    } as T;
}

/**
 * How the credential at `path` of the provider at `index` of its
 * `kms.json` is used: by the tenant whose file holds it, or the instance
 * for the global file, sent to the address its destination setting names.
 */
export function kmsCredentialUse(
    scope: SecretScope,
    index: number,
    provider: KmsProviderConfig,
    path: (string | number)[],
): SecretUse {
    const destinationPath = Object.entries(
        KMS_CREDENTIAL_DESTINATIONS[provider.type] ?? {},
    ).find(([pattern]) => matches(pattern, path))?.[1]?.[0];
    const destination =
        provider.type === "aws-kms"
            ? `https://kms.${(provider as { region?: string }).region}.amazonaws.com`
            : destinationPath
              ? valueAt(provider, destinationPath.split("."))
              : undefined;
    return {
        scope,
        field: `KmsConfig:providers.${index}.${path.join(".")}`,
        ...(typeof destination === "string" ? { destination } : {}),
    };
}
