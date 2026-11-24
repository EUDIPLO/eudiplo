import { createHash, X509Certificate } from "node:crypto";
import { HttpService } from "@nestjs/axios";
import { Logger, NotImplementedException } from "@nestjs/common";
import type { JWK } from "jose";
import { firstValueFrom } from "rxjs";
import {
    assertKmsSigningAlg,
    derEcdsaToRaw,
    externalAlgorithmPolicy,
    KMS_SIGNING_ALGS,
    type KmsAlgorithmPolicy,
    resolveAlgorithmCapabilities,
    signingAlgForCurve,
    signingAlgSpec,
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

const DEFAULT_API_PATH = "/csc/v2";

interface CscAuthorizeAuthData {
    id: string;
    value: string;
}

export interface CscKmsAdapterConfig {
    providerId: string;
    baseUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    scope?: string;
    credentialId?: string;
    userId?: string;
    hashAlgorithmOid?: string;
    signAlgorithmOid?: string;
    sad?: string;
    useAuthorizeEndpoint?: boolean;
    authorizeAuthData?: CscAuthorizeAuthData[];
    apiPath?: string;
    /**
     * Algorithms allowed for new keys (from `kms.json`). Set it to the
     * algorithm of the credential's curve.
     */
    algorithms?: KmsAlgorithmPolicy;
}

/**
 * CSC (Cloud Signature Consortium) adapter.
 *
 * Integrates with CSC v2 APIs for remote signing:
 * - credentials/list
 * - credentials/info
 * - signatures/signHash
 *
 * Optional SAD acquisition via credentials/authorize is supported when
 * configured.
 */
export class CscKmsAdapter implements KmsAdapter {
    private readonly logger = new Logger(CscKmsAdapter.name);

    readonly providerId: string;
    readonly type: KmsProviderType = "csc";
    readonly capabilities: KmsAdapterCapabilities;

    private readonly baseUrl: string;
    private readonly tokenUrl: string;
    private readonly clientId: string;
    private readonly clientSecret: string;
    private readonly scope?: string;
    private readonly configuredCredentialId?: string;
    private readonly userId?: string;
    /** Configured OIDs; without them the OIDs follow the key's algorithm. */
    private readonly hashAlgorithmOid?: string;
    private readonly signAlgorithmOid?: string;
    private readonly configuredSad?: string;
    private readonly useAuthorizeEndpoint: boolean;
    private readonly authorizeAuthData?: CscAuthorizeAuthData[];
    private readonly apiPath: string;
    private readonly jwkCache = new PublicJwkCache();

    private oauth2TokenCache: {
        accessToken: string;
        expiresAt: number;
    } | null = null;

    private resolvedCredentialId: string | null = null;

    constructor(
        config: CscKmsAdapterConfig,
        private readonly http: HttpService,
    ) {
        this.providerId = config.providerId;
        this.baseUrl = config.baseUrl.replace(/\/$/, "");
        this.tokenUrl = config.tokenUrl;
        this.clientId = config.clientId;
        this.clientSecret = config.clientSecret;
        this.scope = config.scope;
        this.configuredCredentialId = config.credentialId;
        this.userId = config.userId;
        this.hashAlgorithmOid = config.hashAlgorithmOid || undefined;
        this.signAlgorithmOid = config.signAlgorithmOid || undefined;
        this.capabilities = {
            canCreate: true,
            canImport: false,
            canDelete: false,
            // The credential's curve is unknown up front: the default only, unless configured.
            ...resolveAlgorithmCapabilities(
                KMS_SIGNING_ALGS,
                externalAlgorithmPolicy(config.algorithms),
            ),
        };
        this.configuredSad = config.sad;
        this.useAuthorizeEndpoint = Boolean(config.useAuthorizeEndpoint);
        this.authorizeAuthData = config.authorizeAuthData;
        this.apiPath = config.apiPath ?? DEFAULT_API_PATH;
        // The credentials belong to baseUrl.
        if (kmsPathLeavesBaseUrl(this.baseUrl, this.apiPath)) {
            throw new Error(
                `CscKmsAdapter[${this.providerId}]: apiPath must be a path on the server of baseUrl`,
            );
        }
    }

    async generateKey(opts: {
        kid: string;
        alg?: KmsSigningAlg;
    }): Promise<KmsKeyMaterial> {
        // Not limited to capabilities.supportedAlgs: rotation keeps the
        // algorithm of an existing key chain.
        const alg = opts.alg ?? this.capabilities.defaultAlg;
        assertKmsSigningAlg(alg, `CscKmsAdapter[${this.providerId}]`);

        const credentialId = await this.resolveCredentialId();
        const publicJwk = await this.fetchPublicJwk(
            credentialId,
            alg,
            opts.kid,
        );
        const credentialAlg = signingAlgForCurve(publicJwk.crv);
        if (credentialAlg !== alg) {
            const hint = credentialAlg ? ` (${credentialAlg})` : "";
            throw new Error(
                `CscKmsAdapter[${this.providerId}]: credential ${credentialId} holds a ${String(publicJwk.crv)} key, which cannot sign with ${alg}. Set "algorithms" of this provider in kms.json to the credential's algorithm${hint}.`,
            );
        }

        return {
            ref: {
                externalKeyId: credentialId,
                publicJwk,
                alg,
            },
        };
    }

    importKey(_opts: {
        kid: string;
        privateJwk: JWK;
        alg?: KmsSigningAlg;
    }): Promise<KmsKeyMaterial> {
        throw new NotImplementedException(
            `CscKmsAdapter[${this.providerId}]: importKey is not supported by CSC provider`,
        );
    }

    async sign(
        ref: KmsKeyRef,
        data: Uint8Array,
        alg?: KmsSigningAlg,
    ): Promise<Uint8Array> {
        const signAlg = alg ?? ref.alg;
        assertKmsSigningAlg(signAlg, `CscKmsAdapter[${this.providerId}]`);
        const spec = signingAlgSpec(signAlg);

        const credentialId =
            ref.externalKeyId ||
            this.configuredCredentialId ||
            (await this.resolveCredentialId());

        const digest = createHash(spec.nodeHash)
            .update(Buffer.from(data))
            .digest();
        const digestB64 = digest.toString("base64");
        const hashAlgorithmOid = this.hashAlgorithmOid ?? spec.hashOid;
        const sad = await this.resolveSad(
            credentialId,
            digestB64,
            hashAlgorithmOid,
        );

        const body: Record<string, unknown> = {
            credentialID: credentialId,
            hashes: [digestB64],
            hashAlgorithmOID: hashAlgorithmOid,
            signAlgo: this.signAlgorithmOid ?? spec.signatureOid,
        };
        if (sad) {
            body.SAD = sad;
        }

        const response = await firstValueFrom(
            this.http.post<{
                signatures?: string[];
                signature?: string;
            }>(
                this.endpoint("/signatures/signHash"),
                body,
                await this.requestConfig(),
            ),
        );

        const encoded =
            response.data?.signatures?.[0] ?? response.data?.signature;
        if (!encoded) {
            throw new Error(
                `CscKmsAdapter[${this.providerId}]: signatures/signHash returned no signature`,
            );
        }

        const signatureBytes = base64UrlOrBase64ToBytes(encoded);
        if (signatureBytes.length === spec.coordinateSize * 2) {
            return signatureBytes;
        }

        if (signatureBytes[0] === 0x30) {
            return derEcdsaToRaw(signatureBytes, spec.coordinateSize);
        }

        throw new Error(
            `CscKmsAdapter[${this.providerId}]: unsupported signature format returned by CSC provider`,
        );
    }

    async deleteKey(_ref: KmsKeyRef): Promise<void> {
        // CSC credentials are managed externally.
    }

    async health(): Promise<KmsHealthResult> {
        const start = Date.now();
        try {
            await this.resolveCredentialId();
            return { ok: true, latencyMs: Date.now() - start };
        } catch (err) {
            return {
                ok: false,
                latencyMs: Date.now() - start,
                error: String(err),
            };
        }
    }

    private async resolveCredentialId(): Promise<string> {
        if (this.configuredCredentialId) {
            this.resolvedCredentialId = this.configuredCredentialId;
            return this.configuredCredentialId;
        }
        if (this.resolvedCredentialId) {
            return this.resolvedCredentialId;
        }

        const body: Record<string, unknown> = {
            certInfo: true,
            authInfo: true,
            credentialInfo: true,
            onlyValid: true,
        };
        if (this.userId) {
            body.userID = this.userId;
        }

        const response = await firstValueFrom(
            this.http.post<{
                credentialIDs?: string[];
                credentialIds?: string[];
            }>(
                this.endpoint("/credentials/list"),
                body,
                await this.requestConfig(),
            ),
        );

        const ids =
            response.data?.credentialIDs ?? response.data?.credentialIds;
        const credentialId = ids?.[0];
        if (!credentialId) {
            throw new Error(
                `CscKmsAdapter[${this.providerId}]: credentials/list returned no credential IDs and no credentialId is configured`,
            );
        }
        this.resolvedCredentialId = credentialId;
        return credentialId;
    }

    private async fetchPublicJwk(
        credentialId: string,
        alg: KmsSigningAlg,
        kid: string,
    ): Promise<JWK> {
        const cacheKey = `${credentialId}:${kid}`;
        const cached = this.jwkCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const response = await firstValueFrom(
            this.http.post<Record<string, unknown>>(
                this.endpoint("/credentials/info"),
                {
                    credentialID: credentialId,
                    certInfo: true,
                    authInfo: true,
                },
                await this.requestConfig(),
            ),
        );

        const certEntry = extractFirstCertificate(response.data);
        if (!certEntry) {
            throw new Error(
                `CscKmsAdapter[${this.providerId}]: credentials/info returned no certificate data for credential ${credentialId}`,
            );
        }

        const certPem = normalizeCertificateToPem(certEntry);
        const x509 = new X509Certificate(certPem);
        const jwk = x509.publicKey.export({ format: "jwk" }) as JWK;
        jwk.kid = kid;
        jwk.alg = signingAlgForCurve(jwk.crv) ?? alg;

        this.jwkCache.set(cacheKey, jwk);
        return jwk;
    }

    private async resolveSad(
        credentialId: string,
        digestB64: string,
        hashAlgorithmOid: string,
    ): Promise<string | undefined> {
        if (this.configuredSad) {
            return this.configuredSad;
        }
        if (!this.useAuthorizeEndpoint) {
            return undefined;
        }

        const body: Record<string, unknown> = {
            credentialID: credentialId,
            numSignatures: 1,
            hashes: [digestB64],
            hashAlgorithmOID: hashAlgorithmOid,
        };
        if (this.authorizeAuthData?.length) {
            body.authData = this.authorizeAuthData;
        }

        const response = await firstValueFrom(
            this.http.post<{ SAD?: string; sad?: string }>(
                this.endpoint("/credentials/authorize"),
                body,
                await this.requestConfig(),
            ),
        );

        const sad = response.data?.SAD ?? response.data?.sad;
        if (!sad) {
            throw new Error(
                `CscKmsAdapter[${this.providerId}]: credentials/authorize returned no SAD`,
            );
        }
        return sad;
    }

    private endpoint(path: string): string {
        return `${this.baseUrl}${this.apiPath}${path}`;
    }

    private async requestConfig(): Promise<{
        headers: Record<string, string>;
    }> {
        const token = await this.getOAuth2Token();
        return {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        };
    }

    private async getOAuth2Token(): Promise<string> {
        const now = Date.now();
        if (this.oauth2TokenCache && this.oauth2TokenCache.expiresAt > now) {
            return this.oauth2TokenCache.accessToken;
        }

        const params = new URLSearchParams({
            grant_type: "client_credentials",
            client_id: this.clientId,
            client_secret: this.clientSecret,
        });
        if (this.scope) {
            params.set("scope", this.scope);
        }

        const response = await firstValueFrom(
            this.http.post<{ access_token: string; expires_in?: number }>(
                this.tokenUrl,
                params.toString(),
                {
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                },
            ),
        );

        const accessToken = response.data?.access_token;
        if (!accessToken) {
            throw new Error(
                `CscKmsAdapter[${this.providerId}]: token endpoint returned no access_token`,
            );
        }

        const expiresIn = response.data?.expires_in ?? 3600;
        this.oauth2TokenCache = {
            accessToken,
            expiresAt: now + Math.max(expiresIn - 30, 10) * 1000,
        };

        return accessToken;
    }
}

function extractFirstCertificate(
    data: Record<string, unknown>,
): string | undefined {
    const certObject = (data.cert as Record<string, unknown> | undefined) || {};
    const certs =
        (certObject.certificates as unknown[] | undefined) ||
        (certObject.certificateChain as unknown[] | undefined) ||
        (data.certificates as unknown[] | undefined);

    const first = certs?.[0];
    if (typeof first === "string" && first.length > 0) {
        return first;
    }

    const single = data.certificate;
    if (typeof single === "string" && single.length > 0) {
        return single;
    }

    return undefined;
}

function normalizeCertificateToPem(value: string): string {
    const trimmed = value.trim();
    if (trimmed.includes("-----BEGIN CERTIFICATE-----")) {
        return trimmed;
    }

    const normalized = trimmed.replace(/\s+/g, "");
    const body =
        Buffer.from(normalized, "base64")
            .toString("base64")
            .match(/.{1,64}/g)
            ?.join("\n") || "";
    return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

function base64UrlOrBase64ToBytes(s: string): Uint8Array {
    const normalized = s.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return new Uint8Array(Buffer.from(padded, "base64"));
}
