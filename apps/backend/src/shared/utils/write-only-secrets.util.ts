import { BadRequestException } from "@nestjs/common";

/**
 * Write-only secrets in API responses: the value is replaced by
 * {@link REDACTED_SECRET}, and an update that sends the marker back keeps the
 * stored value. The tenant KMS configuration uses the same marker.
 */
export const REDACTED_SECRET = "<redacted>";

/** {@link REDACTED_SECRET} was sent where no value is stored. */
export class SecretNotStoredError extends BadRequestException {
    constructor(readonly path: string) {
        super(
            `${path} is '${REDACTED_SECRET}' but no value is stored for it; send the secret`,
        );
        this.name = "SecretNotStoredError";
    }
}

type Leaf = (value: string, stored: unknown, path: string) => string;

/**
 * Apply `leaf` to the strings at `segments`, with the value at the same place
 * of `stored`. `*` matches every key or array item. Array items are paired
 * with the stored item of the same `id` and `type`, or else of the same index.
 */
function walk(
    value: unknown,
    stored: unknown,
    [segment, ...rest]: string[],
    leaf: Leaf,
    path: string,
): unknown {
    if (segment === undefined) {
        return typeof value === "string" ? leaf(value, stored, path) : value;
    }
    if (Array.isArray(value)) {
        const storedItems = Array.isArray(stored) ? stored : [];
        return value.map((item, index) =>
            segment === "*" || segment === String(index)
                ? walk(
                      item,
                      storedItem(item, index, storedItems),
                      rest,
                      leaf,
                      `${path}[${index}]`,
                  )
                : item,
        );
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
                key,
                segment === "*" || segment === key
                    ? walk(
                          item,
                          field(stored, key),
                          rest,
                          leaf,
                          path ? `${path}.${key}` : key,
                      )
                    : item,
            ]),
        );
    }
    return value;
}

function field(value: unknown, key: string): unknown {
    return value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;
}

function storedItem(item: unknown, index: number, stored: unknown[]): unknown {
    const id = field(item, "id");
    if (id === undefined) return stored[index];
    return stored.find(
        (candidate) =>
            field(candidate, "id") === id &&
            field(candidate, "type") === field(item, "type"),
    );
}

/** Copy of `value` with the strings at `paths` replaced by {@link REDACTED_SECRET}. */
export function redactSecrets<T>(value: T, ...paths: string[]): T {
    return paths.reduce<unknown>(
        (current, path) =>
            walk(
                current,
                undefined,
                path.split("."),
                () => REDACTED_SECRET,
                "",
            ),
        value,
    ) as T;
}

/**
 * Copy of `update` in which every {@link REDACTED_SECRET} at `paths` is
 * replaced by the value at the same place of `stored`, the version before the
 * update.
 *
 * @throws SecretNotStoredError when `stored` has no value there.
 */
export function restoreSecrets<T>(
    update: T,
    stored: unknown,
    ...paths: string[]
): T {
    const restore: Leaf = (value, storedValue, path) => {
        if (value !== REDACTED_SECRET) return value;
        if (
            typeof storedValue !== "string" ||
            storedValue === REDACTED_SECRET
        ) {
            throw new SecretNotStoredError(path);
        }
        return storedValue;
    };
    return paths.reduce<unknown>(
        (current, path) => walk(current, stored, path.split("."), restore, ""),
        update,
    ) as T;
}

/** A stored secret would be kept although the address it is sent to changes. */
export class SecretTargetChangedError extends BadRequestException {
    constructor(path: string, target: string) {
        super(
            `${path} must be sent again when ${target} changes; a stored secret is not sent to a new address`,
        );
        this.name = "SecretTargetChangedError";
    }
}

interface WebhookAuthLike {
    type: string;
    config?: { value?: string };
}

/**
 * Reject an update that changes the URL of a webhook endpoint or attribute
 * provider but keeps its stored API key, by omitting `auth` or sending
 * {@link REDACTED_SECRET}: whoever may edit the entry could otherwise send
 * the key to a server of their choice.
 */
export function assertApiKeyKeptOnlyForSameUrl(
    update: { url?: string; auth?: WebhookAuthLike },
    stored: { url: string; auth?: WebhookAuthLike },
): void {
    const keepsKey =
        update.auth === undefined
            ? stored.auth?.type === "apiKey"
            : update.auth.type === "apiKey" &&
              update.auth.config?.value === REDACTED_SECRET;
    if (keepsKey && update.url !== undefined && update.url !== stored.url) {
        throw new SecretTargetChangedError(API_KEY, "url");
    }
}

/** Path of the API key in a webhook endpoint or attribute provider. */
const API_KEY = "auth.config.value";

/** A webhook endpoint or attribute provider for an API response. */
export function redactApiKey<T>(entry: T): T {
    return redactSecrets(entry, API_KEY);
}

/**
 * A create (without `stored`) or update of a webhook endpoint or attribute
 * provider with a redacted API key replaced by the stored one.
 *
 * @throws SecretNotStoredError, SecretTargetChangedError
 */
export function restoreApiKey<
    T extends { url?: string; auth?: WebhookAuthLike },
>(update: T, stored?: { url: string; auth?: WebhookAuthLike }): T {
    if (stored) assertApiKeyKeptOnlyForSameUrl(update, stored);
    return restoreSecrets(update, stored, API_KEY);
}

interface AuthorizationServerLike {
    id?: string;
    type?: string;
    upstream?: { issuer?: string; clientSecret?: string };
}

/**
 * Reject keeping the stored upstream client secret of a chained
 * authorization server ({@link REDACTED_SECRET}) when its upstream issuer
 * changes, for the same reason as {@link assertApiKeyKeptOnlyForSameUrl}.
 */
export function assertUpstreamSecretsKeptOnlyForSameIssuer(
    servers: AuthorizationServerLike[] | null | undefined,
    storedServers: AuthorizationServerLike[] | null | undefined,
): void {
    servers?.forEach((server, index) => {
        if (server.upstream?.clientSecret !== REDACTED_SECRET) return;
        const stored = storedServers?.find(
            (candidate) =>
                candidate.id === server.id && candidate.type === server.type,
        );
        // Without a stored server, restoreSecrets reports the missing secret.
        if (stored && stored.upstream?.issuer !== server.upstream.issuer) {
            throw new SecretTargetChangedError(
                `authorizationServers[${index}].upstream.clientSecret`,
                "upstream.issuer",
            );
        }
    });
}
