import { createHash } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { JWK } from "jose";
import type { SecretReferences } from "../../../../platform/secrets/application/secret-references.js";
import {
    SecretMissingError,
    SecretReferenceInvalidError,
    SecretReferenceRefusedError,
    SecretUnavailableError,
} from "../../../../platform/secrets/domain/secret-errors.js";
import type { SecretUse } from "../../../../platform/secrets/domain/secret-use.js";
import type { KmsProviderConfig } from "../../schemas/kms-config.schema.js";
import type {
    KmsAdapter,
    KmsAdapterCapabilities,
    KmsHealthResult,
    KmsKeyMaterial,
    KmsKeyRef,
    KmsSigningAlg,
} from "../kms-adapter.js";
import { KmsCredentialError } from "../kms-credential-error.js";
import {
    type KmsCredential,
    withCredential,
} from "../kms-credential-references.js";

/**
 * A KMS provider whose credentials include secret references. The
 * references are read when the provider is used, under the operator's
 * secret policy, and an adapter is built from the values. While the values
 * stay the same, that adapter is reused; when one changes (a rotated
 * secret, after the resolver's cache time), a new adapter is built and the
 * old one retired, so its connections or HSM session close once running
 * operations had time to finish.
 */
export class ReferencedKmsAdapter implements KmsAdapter {
    readonly providerId: string;
    readonly type: KmsAdapter["type"];
    readonly capabilities: KmsAdapterCapabilities;
    private current?: { fingerprint: string; adapter: KmsAdapter };
    private readonly logger = new Logger(ReferencedKmsAdapter.name);

    /**
     * @param references the credentials of `provider` that are references
     * @param useOf how the credential at a path is used, for the policy
     * @param build builds an adapter; it must do no I/O, as the adapters'
     * constructors do not
     * @param retire disposes an adapter that is no longer handed out
     * @param hideReasons for a provider of the global file: its health
     * tells tenants only that the credentials cannot be read, and the log
     * names the reference and why
     */
    constructor(
        private readonly provider: KmsProviderConfig,
        private readonly references: readonly KmsCredential[],
        private readonly useOf: (path: KmsCredential["path"]) => SecretUse,
        private readonly secrets: SecretReferences,
        private readonly build: (provider: KmsProviderConfig) => KmsAdapter,
        private readonly retire: (adapter: KmsAdapter) => void,
        private readonly hideReasons = false,
    ) {
        // Only for what is known without the credentials; never used.
        const probe = build(provider);
        this.providerId = probe.providerId;
        this.type = probe.type;
        this.capabilities = probe.capabilities;
    }

    /**
     * The credentials' current values.
     *
     * @throws KmsCredentialError, whose message names no reference; the log
     * and the error's cause have the reason
     */
    private async values(): Promise<string[]> {
        try {
            return (
                await Promise.all(
                    this.references.map((credential) =>
                        this.secrets.valueOf(
                            credential.value,
                            this.useOf(credential.path),
                        ),
                    ),
                )
            ).map((value) => value.reveal());
        } catch (error) {
            const kind =
                error instanceof SecretUnavailableError
                    ? "unavailable"
                    : error instanceof SecretReferenceRefusedError ||
                        error instanceof SecretReferenceInvalidError ||
                        error instanceof SecretMissingError
                      ? "refused"
                      : undefined;
            if (!kind) throw error;
            this.logger.warn(
                `KMS provider '${this.providerId}': ${error instanceof Error ? error.message : String(error)}`,
            );
            throw new KmsCredentialError(this.providerId, kind, {
                cause: error,
                operatorsProvider: this.hideReasons,
            });
        }
    }

    /** The adapter for the credentials' current values. */
    private async adapter(): Promise<KmsAdapter> {
        const values = await this.values();
        const fingerprint = createHash("sha256")
            .update(JSON.stringify(values))
            .digest("hex");
        // No await from here on, so concurrent calls cannot both build.
        if (this.current?.fingerprint === fingerprint)
            return this.current.adapter;
        const resolved = this.references.reduce(
            (provider, credential, index) =>
                withCredential(provider, credential.path, values[index]),
            this.provider,
        );
        const previous = this.current;
        this.current = { fingerprint, adapter: this.build(resolved) };
        if (previous) this.retire(previous.adapter);
        return this.current.adapter;
    }

    async generateKey(opts: {
        kid: string;
        alg?: KmsSigningAlg;
    }): Promise<KmsKeyMaterial> {
        return (await this.adapter()).generateKey(opts);
    }

    async importKey(opts: {
        kid: string;
        privateJwk: JWK;
        alg?: KmsSigningAlg;
    }): Promise<KmsKeyMaterial> {
        return (await this.adapter()).importKey(opts);
    }

    async sign(
        ref: KmsKeyRef,
        data: Uint8Array,
        alg?: KmsSigningAlg,
    ): Promise<Uint8Array> {
        return (await this.adapter()).sign(ref, data, alg);
    }

    async deleteKey(ref: KmsKeyRef): Promise<void> {
        return (await this.adapter()).deleteKey(ref);
    }

    async health(): Promise<KmsHealthResult> {
        let adapter: KmsAdapter;
        try {
            adapter = await this.adapter();
        } catch (error) {
            // A tenant's own provider shows why; the operator's providers
            // only that their credentials cannot be used (logged above).
            const reason =
                error instanceof KmsCredentialError ? error.cause : error;
            // values() logs the credential errors; log the others here.
            if (this.hideReasons && !(error instanceof KmsCredentialError))
                this.logger.warn(
                    `KMS provider '${this.providerId}': ${reason instanceof Error ? reason.message : String(reason)}`,
                );
            return {
                ok: false,
                error:
                    !this.hideReasons && reason instanceof Error
                        ? reason.message
                        : "the credentials of this provider cannot be read",
            };
        }
        return adapter.health();
    }

    async dispose(): Promise<void> {
        const current = this.current;
        this.current = undefined;
        await current?.adapter.dispose?.();
    }
}
