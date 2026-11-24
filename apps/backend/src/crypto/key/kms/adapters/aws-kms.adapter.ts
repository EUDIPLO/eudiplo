import {
    CreateKeyCommand,
    type DescribeKeyCommandOutput,
    GetPublicKeyCommand,
    type KeySpec,
    type KMSClient,
    ListKeysCommand,
    ScheduleKeyDeletionCommand,
    SignCommand,
    type SigningAlgorithmSpec,
} from "@aws-sdk/client-kms";
import { Logger, NotImplementedException } from "@nestjs/common";
import { exportJWK, type JWK } from "jose";
import {
    assertKmsSigningAlg,
    derEcdsaToRaw,
    KMS_SIGNING_ALGS,
    type KmsAlgorithmPolicy,
    resolveAlgorithmCapabilities,
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
import { PublicJwkCache } from "../public-jwk-cache.js";

const AWS_KEY_SPEC: Record<KmsSigningAlg, KeySpec> = {
    ES256: "ECC_NIST_P256",
    ES384: "ECC_NIST_P384",
    ES512: "ECC_NIST_P521",
};

const AWS_SIGNING_ALGORITHM: Record<KmsSigningAlg, SigningAlgorithmSpec> = {
    ES256: "ECDSA_SHA_256",
    ES384: "ECDSA_SHA_384",
    ES512: "ECDSA_SHA_512",
};

export interface AwsKmsAdapterConfig {
    providerId: string;
    region: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    /** Algorithms allowed for new keys (from `kms.json`). */
    algorithms?: KmsAlgorithmPolicy;
}

/**
 * AWS KMS adapter.
 *
 * Generates ECC_NIST_P256, P384 or P521 SIGN_VERIFY keys directly inside AWS KMS;
 * private key material never leaves the HSM-backed service. Signing
 * goes through the KMS `Sign` API and the returned DER ECDSA-Sig-Value
 * is re-encoded as raw `r || s` so it is JWS-compatible. Import of
 * external key material is intentionally not supported.
 */
export class AwsKmsAdapter implements KmsAdapter {
    private readonly logger = new Logger(AwsKmsAdapter.name);
    private clientPromise?: Promise<KMSClient>;

    readonly providerId: string;
    readonly type: KmsProviderType = "aws-kms";
    readonly capabilities: KmsAdapterCapabilities;

    private readonly region: string;
    private readonly accessKeyId?: string;
    private readonly secretAccessKey?: string;
    private readonly jwkCache = new PublicJwkCache();

    constructor(config: AwsKmsAdapterConfig) {
        this.providerId = config.providerId;
        this.region = config.region;
        this.accessKeyId = config.accessKeyId;
        this.secretAccessKey = config.secretAccessKey;
        this.capabilities = {
            canCreate: true,
            canImport: false,
            canDelete: true,
            ...resolveAlgorithmCapabilities(
                KMS_SIGNING_ALGS,
                config.algorithms,
            ),
        };
    }

    async generateKey(opts: {
        kid: string;
        alg?: KmsSigningAlg;
    }): Promise<KmsKeyMaterial> {
        // Not limited to capabilities.supportedAlgs: rotation keeps the
        // algorithm of an existing key chain.
        const alg = opts.alg ?? this.capabilities.defaultAlg;
        assertKmsSigningAlg(alg, `AwsKmsAdapter[${this.providerId}]`);

        const client = await this.client();
        const created = await client.send(
            new CreateKeyCommand({
                KeyUsage: "SIGN_VERIFY",
                KeySpec: AWS_KEY_SPEC[alg],
                Description: `eudiplo:${opts.kid}`,
                Tags: [{ TagKey: "eudiplo-kid", TagValue: opts.kid }],
            }),
        );

        const keyId = created.KeyMetadata?.KeyId;
        if (!keyId) {
            throw new Error(
                `AwsKmsAdapter[${this.providerId}]: CreateKey returned no KeyId`,
            );
        }

        const publicJwk = await this.fetchPublicJwk(keyId, alg, opts.kid);
        return { ref: { externalKeyId: keyId, publicJwk, alg } };
    }

    importKey(_opts: {
        kid: string;
        privateJwk: JWK;
        alg?: KmsSigningAlg;
    }): Promise<KmsKeyMaterial> {
        throw new NotImplementedException(
            `AwsKmsAdapter[${this.providerId}]: importKey is not supported — generate keys inside AWS KMS instead`,
        );
    }

    async sign(
        ref: KmsKeyRef,
        data: Uint8Array,
        alg?: KmsSigningAlg,
    ): Promise<Uint8Array> {
        if (!ref.externalKeyId) {
            throw new Error(
                `AwsKmsAdapter[${this.providerId}]: missing externalKeyId`,
            );
        }
        const signAlg = alg ?? ref.alg;
        assertKmsSigningAlg(signAlg, `AwsKmsAdapter[${this.providerId}]`);

        const client = await this.client();
        const out = await client.send(
            new SignCommand({
                KeyId: ref.externalKeyId,
                Message: data,
                MessageType: "RAW",
                SigningAlgorithm: AWS_SIGNING_ALGORITHM[signAlg],
            }),
        );
        if (!out.Signature) {
            throw new Error(
                `AwsKmsAdapter[${this.providerId}]: Sign returned no signature`,
            );
        }
        return derEcdsaToRaw(
            out.Signature,
            signingAlgSpec(signAlg).coordinateSize,
        );
    }

    async deleteKey(ref: KmsKeyRef): Promise<void> {
        if (!ref.externalKeyId) return;
        this.jwkCache.invalidate(ref.externalKeyId);
        const client = await this.client();
        try {
            await client.send(
                new ScheduleKeyDeletionCommand({
                    KeyId: ref.externalKeyId,
                    PendingWindowInDays: 7,
                }),
            );
        } catch (err) {
            this.logger.warn(
                `Failed to schedule deletion for AWS KMS key ${ref.externalKeyId}: ${String(err)}`,
            );
        }
    }

    async health(): Promise<KmsHealthResult> {
        const start = Date.now();
        try {
            const client = await this.client();
            await client.send(new ListKeysCommand({ Limit: 1 }));
            return { ok: true, latencyMs: Date.now() - start };
        } catch (err) {
            return {
                ok: false,
                latencyMs: Date.now() - start,
                error: String(err),
            };
        }
    }

    /** Close the connections of the AWS client, if one was created. */
    async dispose(): Promise<void> {
        const client = await this.clientPromise?.catch(() => undefined);
        client?.destroy();
    }

    private async client(): Promise<KMSClient> {
        this.clientPromise ??= (async () => {
            const { KMSClient } = await import("@aws-sdk/client-kms");
            return new KMSClient({
                region: this.region,
                ...(this.accessKeyId && this.secretAccessKey
                    ? {
                          credentials: {
                              accessKeyId: this.accessKeyId,
                              secretAccessKey: this.secretAccessKey,
                          },
                      }
                    : {}),
            });
        })();
        return this.clientPromise;
    }

    private async fetchPublicJwk(
        keyId: string,
        alg: KmsSigningAlg,
        kid: string,
    ): Promise<JWK> {
        const cached = this.jwkCache.get(keyId);
        if (cached) return cached;
        const jwk = await this.fetchPublicJwkFromKms(keyId, alg, kid);
        this.jwkCache.set(keyId, jwk);
        return jwk;
    }

    private async fetchPublicJwkFromKms(
        keyId: string,
        alg: KmsSigningAlg,
        kid: string,
    ): Promise<JWK> {
        const client = await this.client();
        const res: DescribeKeyCommandOutput & { PublicKey?: Uint8Array } =
            await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
        const spki = res.PublicKey;
        if (!spki) {
            throw new Error(
                `AwsKmsAdapter[${this.providerId}]: GetPublicKey returned no PublicKey`,
            );
        }

        const cryptoKey = await globalThis.crypto.subtle.importKey(
            "spki",
            spki.buffer.slice(
                spki.byteOffset,
                spki.byteOffset + spki.byteLength,
            ) as ArrayBuffer,
            { name: "ECDSA", namedCurve: signingAlgSpec(alg).crv },
            true,
            ["verify"],
        );
        const jwk = await exportJWK(cryptoKey);
        jwk.kid = kid;
        jwk.alg = alg;
        return jwk;
    }
}
