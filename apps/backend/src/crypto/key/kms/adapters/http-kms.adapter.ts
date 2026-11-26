import * as fs from "node:fs";
import * as https from "node:https";
import { HttpService } from "@nestjs/axios";
import { Logger, NotImplementedException } from "@nestjs/common";
import type { JWK } from "jose";
import { firstValueFrom } from "rxjs";
import { fileAccessHint } from "../../../../shared/utils/file-access-hint.util.js";
import {
    assertKmsSigningAlg,
    externalAlgorithmPolicy,
    KMS_SIGNING_ALGS,
    type KmsAlgorithmPolicy,
    resolveAlgorithmCapabilities,
    signingAlgForCurve,
    signingAlgForJwk,
} from "../../domain/signing-algs.js";
import type { KmsProviderType } from "../../dto/kms-config.dto.js";
import type {
    KmsAdapter,
    KmsAdapterCapabilities,
    KmsHealthResult,
    KmsKeyMaterial,
    KmsKeyRef,
    KmsSigningAlg,
} from "../kms-adapter.js";
import { kmsPathLeavesBaseUrl } from "../kms-request-path.js";
import { PublicJwkCache } from "../public-jwk-cache.js";

/** Largest certificate, key or CA bundle file read for mTLS. */
const MAX_PEM_FILE_BYTES = 1024 * 1024;

/**
 * Authentication configuration for the remote KMS microservice.
 *
 * | type                        | Description                                               |
 * |-----------------------------|-----------------------------------------------------------|
 * | `none`                      | No auth — suitable for trusted private networks           |
 * | `bearer`                    | Static `Authorization: Bearer <token>` header             |
 * | `oauth2-client-credentials` | Short-lived tokens fetched and cached from a token server |
 * | `mtls`                      | Mutual TLS — client cert presented on every connection    |
 */
export type HttpKmsAuth =
    | { type: "none" }
    | { type: "bearer"; token: string }
    | {
          type: "oauth2-client-credentials";
          tokenUrl: string;
          clientId: string;
          clientSecret: string;
          scope?: string;
      }
    | { type: "mtls"; certFile: string; keyFile: string; caFile?: string };

export interface HttpKmsAdapterConfig {
    providerId: string;
    /**
     * Algorithms the remote service accepts for new keys (from
     * `kms.json`). Defaults to ES256 only.
     */
    algorithms?: KmsAlgorithmPolicy;
    /** Base URL of the remote KMS microservice (no trailing slash). */
    baseUrl: string;
    /**
     * Authentication method. Defaults to `none` when omitted.
     */
    auth?: HttpKmsAuth;
    /**
     * Path prefix for key operations. Defaults to `/keys`.
     * Adjust if your service mounts the API under a different path.
     */
    keysPath?: string;
    /**
     * Path for the health check endpoint. Defaults to `/health`.
     */
    healthPath?: string;
    /**
     * Whether the remote service supports key import via
     * `POST {keysPath}/{kid}/import`. Defaults to `false`.
     */
    canImport?: boolean;
}

/**
 * HTTP KMS adapter.
 *
 * Delegates all key-management operations to a remote microservice over
 * HTTP/HTTPS.  Private key material is never handled by the backend
 * process — the remote service is solely responsible for storing and using it.
 *
 * ## Remote service API contract
 *
 * The microservice must implement the following endpoints:
 *
 * | Method   | Path                          | Description                     |
 * |----------|-------------------------------|---------------------------------|
 * | POST     | `{keysPath}`                  | Generate a key                  |
 * | POST     | `{keysPath}/{kid}/sign`       | Produce a signature             |
 * | DELETE   | `{keysPath}/{kid}`            | Delete a key                    |
 * | GET      | `{healthPath}`                | Health check                    |
 * | POST     | `{keysPath}/{kid}/import`     | Import a private JWK (optional) |
 *
 * ### POST `{keysPath}` — generate key
 * Request body:
 * ```json
 * { "kid": "my-key-id", "alg": "ES256" }
 * ```
 * Response (200):
 * ```json
 * { "publicJwk": { "kty": "EC", "crv": "P-256", ... } }
 * ```
 *
 * ### POST `{keysPath}/{kid}/sign` — sign
 * Request body:
 * ```json
 * { "data": "<base64-encoded bytes>", "alg": "ES256" }
 * ```
 * Response (200):
 * ```json
 * { "signature": "<base64url-encoded raw r||s>" }
 * ```
 *
 * ### DELETE `{keysPath}/{kid}` — delete
 * Response: 204 No Content
 *
 * ### GET `{healthPath}` — health
 * Response (200):
 * ```json
 * { "ok": true }
 * ```
 *
 * ### POST `{keysPath}/{kid}/import` — import (optional)
 * Request body:
 * ```json
 * { "privateJwk": { ... }, "alg": "ES256" }
 * ```
 * Response (200):
 * ```json
 * { "publicJwk": { "kty": "EC", "crv": "P-256", ... } }
 * ```
 * Return 404 or 405 if not supported.
 */
export class HttpKmsAdapter implements KmsAdapter {
    private readonly logger = new Logger(HttpKmsAdapter.name);

    readonly providerId: string;
    readonly type: KmsProviderType = "http";
    readonly capabilities: KmsAdapterCapabilities;

    private readonly baseUrl: string;
    private readonly auth: HttpKmsAuth;
    private readonly keysPath: string;
    private readonly healthPath: string;
    private readonly jwkCache = new PublicJwkCache();
    /** Pre-built HTTPS agent for mTLS (undefined for other auth types). */
    private readonly httpsAgent?: https.Agent;
    /** Cached OAuth 2.0 access token and its expiry timestamp. */
    private oauth2TokenCache: {
        accessToken: string;
        expiresAt: number;
    } | null = null;

    constructor(
        config: HttpKmsAdapterConfig,
        private readonly http: HttpService,
    ) {
        this.providerId = config.providerId;
        this.baseUrl = config.baseUrl.replace(/\/$/, "");
        this.auth = config.auth ?? { type: "none" };
        this.keysPath = config.keysPath ?? "/keys";
        this.healthPath = config.healthPath ?? "/health";
        // The credentials and the client certificate belong to baseUrl.
        for (const [setting, path] of [
            ["keysPath", this.keysPath],
            ["healthPath", this.healthPath],
        ]) {
            if (kmsPathLeavesBaseUrl(this.baseUrl, path)) {
                throw new Error(
                    `HttpKmsAdapter[${this.providerId}]: ${setting} must be a path on the server of baseUrl`,
                );
            }
        }
        this.capabilities = {
            canCreate: true,
            canImport: config.canImport ?? false,
            canDelete: true,
            ...resolveAlgorithmCapabilities(
                KMS_SIGNING_ALGS,
                externalAlgorithmPolicy(config.algorithms),
            ),
        };

        if (this.auth.type === "mtls") {
            this.httpsAgent = new https.Agent({
                cert: this.readPemFile(this.auth.certFile, "certFile"),
                key: this.readPemFile(this.auth.keyFile, "keyFile"),
                ca: this.auth.caFile
                    ? this.readPemFile(this.auth.caFile, "caFile")
                    : undefined,
            });
        }
    }

    /**
     * Read a PEM file of the mTLS configuration. Only a regular file of a
     * plausible size is read: reading a device or a pipe would never return
     * and block the process.
     */
    private readPemFile(path: string, setting: string): Buffer {
        // Checked on the open file, so the path cannot be swapped in between.
        let fd: number;
        try {
            fd = fs.openSync(
                path,
                // Non-blocking, so a pipe nobody writes to does not block the open.
                fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0),
            );
        } catch (error) {
            const hint = fileAccessHint(error, path);
            if (!hint) throw error;
            throw new Error(
                `HttpKmsAdapter[${this.providerId}]: auth.${setting} (${path}) cannot be read: ${(error as Error).message}.${hint}`,
                { cause: error },
            );
        }
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.size > MAX_PEM_FILE_BYTES) {
                throw new Error(
                    `HttpKmsAdapter[${this.providerId}]: auth.${setting} must be a regular file of at most ${MAX_PEM_FILE_BYTES} bytes`,
                );
            }
            const content = Buffer.alloc(stat.size);
            let read = 0;
            while (read < content.length) {
                const count = fs.readSync(
                    fd,
                    content,
                    read,
                    content.length - read,
                    read,
                );
                if (count === 0) break;
                read += count;
            }
            return content.subarray(0, read);
        } finally {
            fs.closeSync(fd);
        }
    }

    /** Close the connections of the mTLS agent. */
    dispose(): void {
        this.httpsAgent?.destroy();
    }

    async generateKey(opts: {
        kid: string;
        alg?: KmsSigningAlg;
    }): Promise<KmsKeyMaterial> {
        // Not limited to capabilities.supportedAlgs: rotation keeps the
        // algorithm of an existing key chain.
        const alg = opts.alg ?? this.capabilities.defaultAlg;
        assertKmsSigningAlg(alg, `HttpKmsAdapter[${this.providerId}]`);

        const url = `${this.baseUrl}${this.keysPath}`;
        const response = await firstValueFrom(
            this.http.post<{ publicJwk: JWK }>(
                url,
                { kid: opts.kid, alg },
                await this.requestConfig(),
            ),
        );

        const publicJwk = response.data?.publicJwk;
        if (!publicJwk) {
            throw new Error(
                `HttpKmsAdapter[${this.providerId}]: remote service returned no publicJwk`,
            );
        }
        this.assertCurve(publicJwk, alg);
        publicJwk.kid = opts.kid;
        publicJwk.alg = alg;

        this.jwkCache.set(opts.kid, publicJwk);
        return { ref: { externalKeyId: opts.kid, publicJwk, alg } };
    }

    async importKey(opts: {
        kid: string;
        privateJwk: JWK;
        alg?: KmsSigningAlg;
    }): Promise<KmsKeyMaterial> {
        if (!this.capabilities.canImport) {
            throw new NotImplementedException(
                `HttpKmsAdapter[${this.providerId}]: import is disabled — set canImport: true in kms.json to enable it`,
            );
        }

        const alg = signingAlgForJwk(opts.privateJwk);
        if (opts.alg && opts.alg !== alg) {
            throw new Error(
                `HttpKmsAdapter[${this.providerId}]: key on ${String(opts.privateJwk.crv)} cannot be used with ${opts.alg}`,
            );
        }
        this.assertSupported(alg);

        const url = `${this.baseUrl}${this.keysPath}/${encodeURIComponent(opts.kid)}/import`;
        const response = await firstValueFrom(
            this.http.post<{ publicJwk: JWK }>(
                url,
                { privateJwk: opts.privateJwk, alg },
                await this.requestConfig(),
            ),
        );

        const publicJwk = response.data?.publicJwk;
        if (!publicJwk) {
            throw new Error(
                `HttpKmsAdapter[${this.providerId}]: remote service returned no publicJwk after import`,
            );
        }
        this.assertCurve(publicJwk, alg);
        publicJwk.kid = opts.kid;
        publicJwk.alg = alg;

        this.jwkCache.set(opts.kid, publicJwk);
        return { ref: { externalKeyId: opts.kid, publicJwk, alg } };
    }

    async sign(
        ref: KmsKeyRef,
        data: Uint8Array,
        alg?: KmsSigningAlg,
    ): Promise<Uint8Array> {
        if (!ref.externalKeyId) {
            throw new Error(
                `HttpKmsAdapter[${this.providerId}]: missing externalKeyId on ref`,
            );
        }
        const signAlg = alg ?? ref.alg;
        assertKmsSigningAlg(signAlg, `HttpKmsAdapter[${this.providerId}]`);

        const url = `${this.baseUrl}${this.keysPath}/${encodeURIComponent(ref.externalKeyId)}/sign`;
        const response = await firstValueFrom(
            this.http.post<{ signature: string }>(
                url,
                {
                    data: Buffer.from(data).toString("base64"),
                    alg: signAlg,
                },
                await this.requestConfig(),
            ),
        );

        const sig = response.data?.signature;
        if (!sig) {
            throw new Error(
                `HttpKmsAdapter[${this.providerId}]: remote service returned empty signature`,
            );
        }
        return base64UrlToBytes(sig);
    }

    async deleteKey(ref: KmsKeyRef): Promise<void> {
        if (!ref.externalKeyId) return;
        this.jwkCache.invalidate(ref.externalKeyId);

        const url = `${this.baseUrl}${this.keysPath}/${encodeURIComponent(ref.externalKeyId)}`;
        try {
            await firstValueFrom(
                this.http.delete(url, await this.requestConfig()),
            );
        } catch (err) {
            this.logger.warn(
                `HttpKmsAdapter[${this.providerId}]: failed to delete key ${ref.externalKeyId}: ${String(err)}`,
            );
        }
    }

    async health(): Promise<KmsHealthResult> {
        const start = Date.now();
        try {
            await firstValueFrom(
                this.http.get(
                    `${this.baseUrl}${this.healthPath}`,
                    await this.requestConfig(),
                ),
            );
            return { ok: true, latencyMs: Date.now() - start };
        } catch (err) {
            return {
                ok: false,
                latencyMs: Date.now() - start,
                error: String(err),
            };
        }
    }

    /**
     * Builds the Axios request config (headers + optional httpsAgent) for a
     * request to the remote KMS service.
     *
     * - `none`  → no Authorization header
     * - `bearer` → static `Authorization: Bearer <token>`
     * - `oauth2-client-credentials` → fetches/caches a short-lived access token
     * - `mtls`  → no Authorization header; the pre-built `httpsAgent` carries
     *             the client certificate
     */
    private async requestConfig(): Promise<{
        headers: Record<string, string>;
        httpsAgent?: https.Agent;
    }> {
        const cfg: {
            headers: Record<string, string>;
            httpsAgent?: https.Agent;
        } = {
            headers: {},
            ...(this.httpsAgent ? { httpsAgent: this.httpsAgent } : {}),
        };

        if (this.auth.type === "bearer") {
            cfg.headers["Authorization"] = `Bearer ${this.auth.token}`;
        } else if (this.auth.type === "oauth2-client-credentials") {
            const token = await this.getOAuth2Token();
            cfg.headers["Authorization"] = `Bearer ${token}`;
        }
        // "none" and "mtls" need no Authorization header.
        return cfg;
    }

    /**
     * Returns a valid OAuth 2.0 access token, fetching a new one from the
     * token endpoint when the cached token is absent or within 30 s of expiry.
     */
    private async getOAuth2Token(): Promise<string> {
        if (this.auth.type !== "oauth2-client-credentials") {
            throw new Error(
                `HttpKmsAdapter[${this.providerId}]: getOAuth2Token called with auth type '${this.auth.type}'`,
            );
        }
        const now = Date.now();
        if (this.oauth2TokenCache && this.oauth2TokenCache.expiresAt > now) {
            return this.oauth2TokenCache.accessToken;
        }

        const { tokenUrl, clientId, clientSecret, scope } = this.auth;
        const params = new URLSearchParams({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: clientSecret,
        });
        if (scope) params.set("scope", scope);

        const response = await firstValueFrom(
            this.http.post<{ access_token: string; expires_in?: number }>(
                tokenUrl,
                params.toString(),
                {
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                },
            ),
        );

        const { access_token, expires_in = 3600 } = response.data;
        // Cache with a 30-second early-expiry buffer.
        this.oauth2TokenCache = {
            accessToken: access_token,
            expiresAt: now + (expires_in - 30) * 1000,
        };
        return access_token;
    }

    private assertCurve(publicJwk: JWK, alg: KmsSigningAlg): void {
        if (signingAlgForCurve(publicJwk.crv) !== alg) {
            throw new Error(
                `HttpKmsAdapter[${this.providerId}]: remote service returned a ${String(publicJwk.crv)} key for ${alg}`,
            );
        }
    }

    private assertSupported(alg: KmsSigningAlg): void {
        if (!this.capabilities.supportedAlgs.includes(alg)) {
            throw new Error(
                `HttpKmsAdapter[${this.providerId}]: unsupported algorithm '${alg}'. Supported: ${this.capabilities.supportedAlgs.join(", ")}`,
            );
        }
    }
}

/** Convert base64url or base64 string to Uint8Array. */
function base64UrlToBytes(encoded: string): Uint8Array {
    // Normalise base64url → base64.
    const base64 = encoded
        .replaceAll("-", "+")
        .replaceAll("_", "/")
        .padEnd(encoded.length + ((4 - (encoded.length % 4)) % 4), "=");
    return Buffer.from(base64, "base64");
}
