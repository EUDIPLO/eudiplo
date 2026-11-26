import type { SecretReference } from "@eudiplo/config-format/config-values.js";
import type { SecretScope } from "../domain/secret-use.js";
import { SecretValue } from "../domain/secret-value.js";
import type { SecretSource } from "../ports/secret-source.js";

/** How EUDIPLO logs in to Vault. */
export type VaultAuth =
    | { method: "token"; token: string }
    | {
          method: "approle";
          roleId: string;
          secretId: string;
          /** The mount of the AppRole auth method, `approle` by default. */
          mount?: string;
      };

export interface VaultSecretSourceSettings {
    /** The Vault server, for example `https://vault.example:8200`. */
    address: string;
    auth: VaultAuth;
    /**
     * The KV mounts references may name, with their KV version. A reference
     * to any other mount (`sys`, `auth`, `identity`, a transit mount) is
     * refused before a request is made.
     */
    mounts: Readonly<Record<string, { version: 1 | 2 }>>;
    /** Vault Enterprise namespace (`X-Vault-Namespace`). */
    namespace?: string;
    /**
     * Allow `http:` for an address that is not a loopback address. The
     * token and the AppRole credentials then travel unencrypted.
     */
    allowHttp?: boolean;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

interface VaultBody {
    data?: Record<string, unknown> & { data?: unknown };
    auth?: { client_token?: unknown; lease_duration?: unknown };
}

const SEGMENT = /^[A-Za-z0-9._~+=,:-]+$/;
const TENANT_SEGMENT = "{tenant}";
const FIELD = /^[A-Za-z0-9._-]+$/;

/** Renew an AppRole token this long before it expires. */
const RENEW_BEFORE_MS = 30_000;
/**
 * A token Vault refuses is replaced by a new AppRole login at most this
 * often, so that references a tenant names cannot make EUDIPLO log in (and
 * create a token and lease) on every read.
 */
const MIN_RELOGIN_INTERVAL_MS = 30_000;
/** A login is not bound to the read that needs it, which may give up. */
const LOGIN_TIMEOUT_MS = 5_000;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** More than a KV secret or a login answer ever needs. */
const MAX_BODY_BYTES = 256 * 1024;

/** The body as text, or unavailable when it is larger than MAX_BODY_BYTES. */
async function readLimited(response: Response): Promise<string> {
    const tooLarge = () =>
        new VaultUnavailableError(
            `Vault answered with more than ${MAX_BODY_BYTES} bytes`,
        );
    if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES)
        throw tooLarge();
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
            // Not awaited: the rest of the body is of no interest.
            reader.cancel().catch(() => undefined);
            throw tooLarge();
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}

/** The source could not be asked; the resolver serves a cached value. */
export class VaultUnavailableError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "VaultUnavailableError";
    }
}

/** Why one segment of a grant path is none, or undefined. */
function segmentProblem(segment: string): string | undefined {
    if (segment === TENANT_SEGMENT) return undefined;
    if (segment.includes(TENANT_SEGMENT))
        return "{tenant} must be a whole path segment, such as kv/tenants/{tenant}/";
    if (segment === "." || segment === ".." || !SEGMENT.test(segment))
        return "a vault grant is a path of segments of A-Z, a-z, 0-9 and ._~+=,:- with no empty, . or .. segment";
    return undefined;
}

const keyOf = (reference: SecretReference) =>
    reference.source === "vault" ? `${reference.mount}/${reference.path}` : "";

/**
 * `${vault:<mount>/<path>#<key>[@<version>]}`: a key of a secret in a KV
 * secrets engine of HashiCorp Vault (v1 or v2).
 *
 * EUDIPLO logs in with its own token or AppRole, configured for the
 * instance: a reference names a path, never a server, so a tenant cannot
 * point EUDIPLO's credentials at a server of its own. Only the KV mounts
 * listed in the settings can be named.
 *
 * A read that Vault answers with 404 (no such secret, version or key) or
 * 403 for the path is a missing value. When Vault refuses EUDIPLO's own
 * token, the source logs in again (AppRole) or reports itself unavailable
 * (token), so the resolver serves cached values instead of treating every
 * secret as deleted.
 */
export class VaultSecretSource implements SecretSource {
    readonly type = "vault";
    readonly tenantTemplates = true;

    private readonly address: string;
    private token?: { value: string; expiresAt: number; issuedAt: number };
    private login?: Promise<string>;

    /**
     * @throws when the address is no http(s) URL, or uses `http:` for a
     * host that is not a loopback address without `allowHttp`
     */
    constructor(
        private readonly settings: VaultSecretSourceSettings,
        private readonly fetchFn: Fetch = (url, init) => fetch(url, init),
        private readonly now: () => number = Date.now,
    ) {
        const url = new URL(settings.address);
        if (url.protocol !== "https:" && url.protocol !== "http:")
            throw new Error("The Vault address is no http(s) URL");
        if (
            url.protocol === "http:" &&
            !LOOPBACK.has(url.hostname) &&
            !settings.allowHttp
        )
            throw new Error(
                "The Vault address uses http:, which would send the token unencrypted; use https: or allow http explicitly",
            );
        let end = settings.address.length;
        while (end > 0 && settings.address[end - 1] === "/") end--;
        this.address = settings.address.slice(0, end);
        if (settings.auth.method === "token")
            this.token = {
                value: settings.auth.token,
                expiresAt: Number.POSITIVE_INFINITY,
                issuedAt: Number.NEGATIVE_INFINITY,
            };
    }

    validatePattern(pattern: string): string | undefined {
        const hash = pattern.indexOf("#");
        const path = hash === -1 ? pattern : pattern.slice(0, hash);
        const field = hash === -1 ? undefined : pattern.slice(hash + 1);
        const prefix = path.endsWith("/");
        const segments = (prefix ? path.slice(0, -1) : path).split("/");
        if (prefix && field !== undefined)
            return "a vault grant is a path ending in /, a secret, or a secret#key";
        if (field !== undefined && !FIELD.test(field))
            return "the key after # is made of A-Z, a-z, 0-9, ., _ and -";
        if (!prefix && segments.length < 2)
            return "a vault grant names a mount and a path, such as kv/eudiplo/";
        const problem = segments.map(segmentProblem).find(Boolean);
        if (problem) return problem;
        if (segments[0] === TENANT_SEGMENT)
            return "{tenant} cannot be the mount";
        const mount = segments[0];
        if (!Object.hasOwn(this.settings.mounts, mount))
            return `'${mount}' is no KV mount this instance lists for references`;
        return undefined;
    }

    within(reference: SecretReference, pattern: string): boolean {
        if (reference.source !== "vault") return false;
        return this.contains(pattern, `${keyOf(reference)}#${reference.field}`);
    }

    /**
     * A pattern is a set of references: `kv/eudiplo/tenants/` (ending in
     * `/`) every secret below the path, `kv/operator/csc` every key of one
     * secret, `kv/operator/csc#clientSecret` one key of one secret.
     */
    contains(outer: string, inner: string): boolean {
        if (outer.endsWith("/")) return inner.startsWith(outer);
        if (!outer.includes("#"))
            return inner === outer || inner.startsWith(`${outer}#`);
        return inner === outer;
    }

    overlaps(pattern: string, other: string): boolean {
        return this.contains(pattern, other) || this.contains(other, pattern);
    }

    refusal(
        reference: SecretReference,
        _scopeType: SecretScope["type"],
    ): string | undefined {
        if (reference.source !== "vault") return undefined;
        if (!Object.hasOwn(this.settings.mounts, reference.mount))
            return `'${reference.mount}' is no KV mount this instance lists for references`;
        if (
            reference.version !== undefined &&
            this.settings.mounts[reference.mount].version === 1
        )
            return `'${reference.mount}' is a KV version 1 mount, which keeps no versions`;
        return undefined;
    }

    async read(
        reference: SecretReference,
        signal: AbortSignal,
    ): Promise<SecretValue | undefined> {
        if (reference.source !== "vault" || this.refusal(reference, "instance"))
            return undefined;
        const url = this.url(reference);
        const sent = await this.currentToken();
        let response = await this.send(url, sent, signal);
        if (response.status === 403 && !(await this.accepts(sent, signal))) {
            // Vault refuses EUDIPLO's own token, not only this path.
            response = await this.send(
                url,
                await this.replaceToken(sent),
                signal,
            );
        }
        // No such secret, version or key, or a path this token may not read.
        if ([400, 403, 404].includes(response.status)) return undefined;
        if (!response.ok)
            throw new VaultUnavailableError(
                `Vault answered ${response.status}`,
            );
        const body = await this.json(response);
        const version = this.settings.mounts[reference.mount].version;
        const data = version === 2 ? body.data?.data : body.data;
        const value =
            data && typeof data === "object"
                ? (data as Record<string, unknown>)[reference.field]
                : undefined;
        return typeof value === "string" && value !== ""
            ? new SecretValue(value)
            : undefined;
    }

    private url(reference: SecretReference & { source: "vault" }): string {
        const path = reference.path
            .split("/")
            .map((segment) => encodeURIComponent(segment))
            .join("/");
        const mount = encodeURIComponent(reference.mount);
        if (this.settings.mounts[reference.mount].version === 1)
            return `${this.address}/v1/${mount}/${path}`;
        const version =
            reference.version === undefined
                ? ""
                : `?version=${reference.version}`;
        return `${this.address}/v1/${mount}/data/${path}${version}`;
    }

    /**
     * Whether Vault accepts the token `sent`. Asked only after a 403, so
     * that a path the token may not read is not taken for a refused token.
     *
     * @throws when Vault does not answer the question
     */
    private async accepts(sent: string, signal: AbortSignal): Promise<boolean> {
        const lookup = await this.send(
            `${this.address}/v1/auth/token/lookup-self`,
            sent,
            signal,
        );
        if (lookup.status === 401 || lookup.status === 403) return false;
        if (!lookup.ok)
            throw new VaultUnavailableError(
                `Vault answered ${lookup.status} to a token lookup`,
            );
        return true;
    }

    /**
     * A new token for the refused one, `sent`: with AppRole a new login,
     * unless the last one is too recent; with a static token none.
     */
    private async replaceToken(sent: string): Promise<string> {
        const refused = new VaultUnavailableError(
            "Vault refuses the token of this instance",
        );
        if (this.settings.auth.method === "token") throw refused;
        // Another read may have logged in again already.
        if (this.token && this.token.value !== sent) return this.token.value;
        if (
            this.token &&
            this.now() < this.token.issuedAt + MIN_RELOGIN_INTERVAL_MS
        )
            throw refused;
        this.token = undefined;
        return this.currentToken();
    }

    private async send(
        url: string,
        token: string,
        signal: AbortSignal,
    ): Promise<Response> {
        try {
            return await this.fetchFn(url, {
                method: "GET",
                headers: this.headers({ "X-Vault-Token": token }),
                // The token is never sent to an address Vault redirects to.
                redirect: "error",
                signal,
            });
        } catch (error) {
            throw new VaultUnavailableError("Vault cannot be reached", {
                cause: error,
            });
        }
    }

    /** The JSON body of a successful answer. */
    /** The JSON body of a successful answer, read up to MAX_BODY_BYTES. */
    private async json(response: Response): Promise<VaultBody> {
        const text = await readLimited(response);
        try {
            const body: unknown = JSON.parse(text);
            if (body && typeof body === "object") return body as VaultBody;
        } catch {
            // Reported below.
        }
        // For example the page of a proxy in front of Vault.
        throw new VaultUnavailableError("Vault answered with no JSON object");
    }

    private headers(extra: Record<string, string>): Record<string, string> {
        return this.settings.namespace
            ? { ...extra, "X-Vault-Namespace": this.settings.namespace }
            : extra;
    }

    private async currentToken(): Promise<string> {
        if (this.token && this.now() < this.token.expiresAt - RENEW_BEFORE_MS)
            return this.token.value;
        const auth = this.settings.auth;
        // A static token never expires and is never cleared.
        if (auth.method === "token") return auth.token;
        this.login ??= this.appRoleLogin(auth).finally(() => {
            this.login = undefined;
        });
        return this.login;
    }

    private async appRoleLogin(
        auth: VaultAuth & { method: "approle" },
    ): Promise<string> {
        const mount = encodeURIComponent(auth.mount ?? "approle");
        let response: Response;
        try {
            response = await this.fetchFn(
                `${this.address}/v1/auth/${mount}/login`,
                {
                    method: "POST",
                    headers: this.headers({
                        "Content-Type": "application/json",
                    }),
                    body: JSON.stringify({
                        role_id: auth.roleId,
                        secret_id: auth.secretId,
                    }),
                    redirect: "error",
                    signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
                },
            );
        } catch (error) {
            throw new VaultUnavailableError("Vault cannot be reached", {
                cause: error,
            });
        }
        const body = response.ok
            ? await this.json(response).catch(() => undefined)
            : undefined;
        const token = body?.auth?.client_token;
        if (typeof token !== "string")
            throw new VaultUnavailableError(
                `Vault refuses the AppRole login of this instance (${response.status})`,
            );
        const lease = Number(body?.auth?.lease_duration);
        const now = this.now();
        this.token = {
            value: token,
            issuedAt: now,
            expiresAt:
                Number.isFinite(lease) && lease > 0
                    ? now + lease * 1_000
                    : Number.POSITIVE_INFINITY,
        };
        return token;
    }
}
