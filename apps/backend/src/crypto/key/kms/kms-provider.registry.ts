import { HttpService } from "@nestjs/axios";
import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from "@nestjs/common";
import * as x509 from "@peculiar/x509";
import axios from "axios";
import {
    SECRET_REFERENCES,
    SecretReferences,
} from "../../../platform/secrets/application/secret-references.js";
import type { SecretScope } from "../../../platform/secrets/domain/secret-use.js";
import { OutboundUrlPolicyService } from "../../../webhook/outbound-url-policy.service.js";
import type { KmsAlgorithmPolicy } from "../domain/signing-algs.js";
import type { KmsProviderInfoDto } from "../dto/kms-provider-capabilities.dto.js";
import type { KmsProvidersResponseDto } from "../dto/kms-providers-response.dto.js";
import type {
    KmsConfig,
    KmsProviderConfig,
    KmsProviderType,
} from "../schemas/kms-config.schema.js";
import { AwsKmsAdapter } from "./adapters/aws-kms.adapter.js";
import { CscKmsAdapter } from "./adapters/csc-kms.adapter.js";
import { DbKmsAdapter } from "./adapters/db-kms.adapter.js";
import { HttpKmsAdapter } from "./adapters/http-kms.adapter.js";
import { Pkcs11KmsAdapter } from "./adapters/pkcs11-kms.adapter.js";
import { ReferencedKmsAdapter } from "./adapters/referenced-kms-adapter.js";
import { VaultKmsAdapter } from "./adapters/vault-kms.adapter.js";
import type { KmsAdapter } from "./kms-adapter.js";
import { KmsConfigService } from "./kms-config.service.js";
import {
    kmsCredentials,
    kmsCredentialUse,
} from "./kms-credential-references.js";
import { KmsCryptoProvider } from "./kms-crypto-provider.js";

const DEFAULT_PROVIDER_ID = "db";

/**
 * How long adapters that are no longer handed out stay usable before they
 * are disposed, so that operations that resolved them earlier, such as a
 * signature waiting for its KMS, can finish. A bound, not a guarantee: an
 * operation that takes longer may fail.
 */
export const RETIRED_ADAPTER_GRACE_MS = 60_000;

/** Deadline of a request to a provider of a tenant `kms.json`. */
const TENANT_KMS_TIMEOUT_MS = 30_000;

/** Largest request or response body of a provider of a tenant `kms.json`. */
const TENANT_KMS_MAX_BYTES = 1024 * 1024;

/**
 * Registry that loads `kms.json`, instantiates one {@link KmsAdapter}
 * per configured provider, and resolves them by id.
 *
 * If `kms.json` is missing, a single `db` adapter is registered under
 * the id `"db"` so existing deployments keep working.
 */
@Injectable()
export class KmsProviderRegistry implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(KmsProviderRegistry.name);
    private globalBundle: {
        adapters: Map<string, KmsAdapter>;
        defaultProviderId: string;
    } = {
        adapters: new Map<string, KmsAdapter>(),
        defaultProviderId: DEFAULT_PROVIDER_ID,
    };
    private readonly tenantBundles = new Map<
        string,
        {
            /** The configuration the adapters were built from. */
            config: KmsConfig;
            adapters: Map<string, KmsAdapter>;
            defaultProviderId: string;
        }
    >();

    /** Adapters that are no longer handed out, by the timer that disposes them. */
    private readonly retiring = new Map<
        ReturnType<typeof setTimeout>,
        KmsAdapter[]
    >();

    /**
     * For the providers of a tenant `kms.json`, whose servers the tenant's
     * administrators choose: every connection is checked against the outbound
     * URL policy (no private or loopback address unless the operator allows
     * it), no connection of another provider is reused, and no redirect is
     * followed, which could lead to such an address or take a credential
     * header along. Requests are bound in time and size, so such a server
     * cannot hold or fill the process all tenants share.
     */
    private readonly tenantHttpService: HttpService;

    constructor(
        private readonly kmsConfig: KmsConfigService,
        private readonly httpService: HttpService,
        outboundUrlPolicy: OutboundUrlPolicyService,
        // Required, so a missing binding fails the startup instead of
        // sending references as text; specs pass none and get no policy.
        @Inject(SECRET_REFERENCES)
        private readonly secrets: SecretReferences = new SecretReferences(),
    ) {
        const client = axios.create({
            lookup: outboundUrlPolicy.safeLookup as never,
            httpAgent: false,
            httpsAgent: false,
            maxRedirects: 0,
            // Not through HTTPS_PROXY: the address check would then see
            // the proxy, not the server.
            proxy: false,
            timeout: TENANT_KMS_TIMEOUT_MS,
            maxContentLength: TENANT_KMS_MAX_BYTES,
            maxBodyLength: TENANT_KMS_MAX_BYTES,
        });
        // `timeout` only bounds the connection and each pause of the answer;
        // this ends a request whose answer trickles in.
        client.interceptors.request.use((config) => {
            const deadline = AbortSignal.timeout(TENANT_KMS_TIMEOUT_MS);
            // HttpService sets a signal of its own on every request.
            config.signal = config.signal
                ? AbortSignal.any([config.signal as AbortSignal, deadline])
                : deadline;
            return config;
        });
        this.tenantHttpService = new HttpService(client);
    }

    onModuleInit(): void {
        this.globalBundle = this.buildBundle(this.kmsConfig.getConfig());

        this.logger.log(
            `Registered global KMS providers: ${[...this.globalBundle.adapters.keys()].join(", ")} (default: ${this.globalBundle.defaultProviderId})`,
        );

        // Install our KMS-aware crypto provider so @peculiar/x509 routes
        // certificate signature generation back to the configured KMS
        // adapter — private key material never leaves the backend.
        x509.cryptoProvider.set(new KmsCryptoProvider());
    }

    /**
     * Resolve an adapter of the tenant together with the tenant's stored
     * `kms.json` the adapter was built from, so that whose the provider is
     * (tenantOwnsKmsProvider) is judged for the provider that is used.
     */
    resolveWithTenantFile(
        providerId: string | undefined,
        tenantId: string,
    ): { adapter: KmsAdapter; tenantFile: KmsConfig | null } {
        const { config, file } = this.kmsConfig.getTenantSnapshot(tenantId);
        return {
            adapter: this.adapterOf(
                this.getBundle(tenantId, config),
                providerId,
            ),
            tenantFile: file,
        };
    }

    /** Resolve an adapter by provider id. Throws if not registered. */
    resolve(providerId?: string, tenantId?: string): KmsAdapter {
        return this.adapterOf(this.getBundle(tenantId), providerId);
    }

    private adapterOf(
        bundle: {
            adapters: Map<string, KmsAdapter>;
            defaultProviderId: string;
        },
        providerId?: string,
    ): KmsAdapter {
        const id = providerId || bundle.defaultProviderId;
        const adapter = bundle.adapters.get(id);
        if (!adapter) {
            throw new BadRequestException(
                `Unknown KMS provider '${id}'. Configured providers: ${[...bundle.adapters.keys()].join(", ")}`,
            );
        }
        return adapter;
    }

    getDefault(tenantId?: string): KmsAdapter {
        return this.resolve(undefined, tenantId);
    }

    /** Return the public view of registered providers (for the API). */
    list(tenantId?: string): KmsProvidersResponseDto {
        const bundle = this.getBundle(tenantId);
        const providers: KmsProviderInfoDto[] = [
            ...bundle.adapters.values(),
        ].map((a) => ({
            name: a.providerId,
            type: a.type,
            capabilities: a.capabilities,
        }));
        return { providers, default: bundle.defaultProviderId };
    }

    /**
     * Run the health probe for every registered adapter in parallel.
     */
    async health(tenantId?: string): Promise<
        Array<{
            providerId: string;
            type: string;
            ok: boolean;
            latencyMs?: number;
            error?: string;
        }>
    > {
        const bundle = this.getBundle(tenantId);
        const entries = [...bundle.adapters.values()];
        return Promise.all(
            entries.map(async (a) => {
                const result = await a.health();
                return {
                    providerId: a.providerId,
                    type: a.type,
                    ...result,
                };
            }),
        );
    }

    private getBundle(
        tenantId?: string,
        tenantConfig?: KmsConfig,
    ): {
        adapters: Map<string, KmsAdapter>;
        defaultProviderId: string;
    } {
        if (!tenantId) {
            return this.globalBundle;
        }

        // The configuration service hands out a new object when the tenant's
        // kms.json changed, also when another process wrote it.
        const config = tenantConfig ?? this.kmsConfig.getConfig(tenantId);
        const cached = this.tenantBundles.get(tenantId);
        if (cached?.config === config) {
            return cached;
        }

        const bundle = { config, ...this.buildBundle(config, tenantId) };
        this.tenantBundles.set(tenantId, bundle);
        if (cached) this.retire(cached.adapters.values());
        return bundle;
    }

    /**
     * @param tenantId the tenant whose `kms.json` the providers that are not
     * the global file's come from
     */
    private buildBundle(
        config: KmsConfig,
        tenantId?: string,
    ): {
        adapters: Map<string, KmsAdapter>;
        defaultProviderId: string;
    } {
        const adapters = new Map<string, KmsAdapter>();
        const defaultProviderId = config.defaultProvider || DEFAULT_PROVIDER_ID;

        // mergeConfigs hands on the providers of the global file as they
        // are, so every other provider comes from the tenant's file.
        const global = new Set(this.kmsConfig.getConfig().providers);
        for (const provider of config.providers) {
            const isGlobal = global.has(provider);
            // Whose file the provider's credentials come from, for the
            // policy of their secret references.
            const scope: SecretScope =
                isGlobal || tenantId === undefined
                    ? { type: "instance" }
                    : { type: "tenant", tenantId };
            adapters.set(
                provider.id,
                this.instantiateWithReferences(
                    provider,
                    isGlobal ? this.httpService : this.tenantHttpService,
                    scope,
                ),
            );
        }

        // Always ensure a default db adapter exists.
        if (!adapters.has(DEFAULT_PROVIDER_ID)) {
            adapters.set(
                DEFAULT_PROVIDER_ID,
                new DbKmsAdapter(DEFAULT_PROVIDER_ID),
            );
        }

        return {
            adapters,
            defaultProviderId,
        };
    }

    invalidateTenant(tenantId: string): void {
        const cached = this.tenantBundles.get(tenantId);
        this.tenantBundles.delete(tenantId);
        if (cached) this.retire(cached.adapters.values());
    }

    /**
     * Dispose adapters that are no longer handed out, after
     * RETIRED_ADAPTER_GRACE_MS. Every tenant file that changes replaces the
     * tenant's adapters; without this, each replaced adapter would keep its
     * HSM session or connections for the life of the process.
     */
    private retire(adapters: Iterable<KmsAdapter>): void {
        const disposable = [...adapters].filter((adapter) => adapter.dispose);
        if (disposable.length === 0) return;
        const timer = setTimeout(() => {
            this.retiring.delete(timer);
            void this.dispose(disposable);
        }, RETIRED_ADAPTER_GRACE_MS);
        // Does not keep the process alive, whose end closes them anyway.
        timer.unref();
        this.retiring.set(timer, disposable);
    }

    private async dispose(adapters: Iterable<KmsAdapter>): Promise<void> {
        for (const adapter of adapters) {
            try {
                await adapter.dispose?.();
            } catch (err) {
                this.logger.warn(
                    `Failed to dispose KMS provider '${adapter.providerId}': ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            }
        }
    }

    /** Dispose every adapter: retired ones at once, then those in use. */
    async onModuleDestroy(): Promise<void> {
        const retired = [...this.retiring.entries()];
        this.retiring.clear();
        for (const [timer, adapters] of retired) {
            clearTimeout(timer);
            await this.dispose(adapters);
        }
        const tenants = [...this.tenantBundles.values()];
        this.tenantBundles.clear();
        for (const bundle of tenants) {
            await this.dispose(bundle.adapters.values());
        }
        await this.dispose(this.globalBundle.adapters.values());
    }

    /**
     * The adapter of `provider`, or, when credentials of it are secret
     * references, one that reads them under the policy when it is used and
     * rebuilds the adapter when a value changes.
     */
    private instantiateWithReferences(
        provider: KmsProviderConfig,
        httpService: HttpService,
        scope: SecretScope,
    ): KmsAdapter {
        const references = kmsCredentials(provider).filter((credential) =>
            this.secrets.isReference(credential.value),
        );
        if (references.length === 0)
            return this.instantiate(provider, httpService);
        return new ReferencedKmsAdapter(
            provider,
            references,
            (path) => kmsCredentialUse(scope, provider, path),
            this.secrets,
            (resolved) => this.instantiate(resolved, httpService),
            (adapter) => this.retire([adapter]),
            // The operator's references are not shown to tenants.
            scope.type === "instance",
        );
    }

    /**
     * @param httpService what the adapter sends its requests with: the
     * policy-bound one for a provider of a tenant file
     */
    private instantiate(
        provider: KmsProviderConfig,
        httpService: HttpService,
    ): KmsAdapter {
        const type: KmsProviderType = provider.type;
        switch (type) {
            case "db":
                return new DbKmsAdapter(provider.id, algorithmPolicy(provider));
            case "vault": {
                const p = provider as Extract<
                    KmsProviderConfig,
                    { type: "vault" }
                >;
                return new VaultKmsAdapter(
                    {
                        providerId: provider.id,
                        vaultUrl: p.vaultUrl,
                        vaultToken: p.vaultToken,
                        algorithms: algorithmPolicy(provider),
                    },
                    httpService,
                );
            }
            case "aws-kms": {
                const p = provider as Extract<
                    KmsProviderConfig,
                    { type: "aws-kms" }
                >;
                return new AwsKmsAdapter({
                    providerId: provider.id,
                    region: p.region,
                    accessKeyId: p.accessKeyId,
                    secretAccessKey: p.secretAccessKey,
                    algorithms: algorithmPolicy(provider),
                });
            }
            case "pkcs11": {
                const p = provider as Extract<
                    KmsProviderConfig,
                    { type: "pkcs11" }
                >;
                const slot =
                    typeof p.slot === "string" && /^\d+$/.test(p.slot)
                        ? Number(p.slot)
                        : p.slot;
                return new Pkcs11KmsAdapter({
                    providerId: provider.id,
                    library: p.library,
                    slot,
                    pin: p.pin,
                    readOnly: p.readOnly,
                    algorithms: algorithmPolicy(provider),
                });
            }
            case "http": {
                const p = provider as Extract<
                    KmsProviderConfig,
                    { type: "http" }
                >;
                return new HttpKmsAdapter(
                    {
                        providerId: provider.id,
                        baseUrl: p.baseUrl,
                        auth: p.auth,
                        keysPath: p.keysPath,
                        healthPath: p.healthPath,
                        canImport: p.canImport,
                        algorithms: algorithmPolicy(provider),
                    },
                    httpService,
                );
            }
            case "csc": {
                const p = provider as Extract<
                    KmsProviderConfig,
                    { type: "csc" }
                >;
                return new CscKmsAdapter(
                    {
                        providerId: provider.id,
                        baseUrl: p.baseUrl,
                        tokenUrl: p.tokenUrl,
                        clientId: p.clientId,
                        clientSecret: p.clientSecret,
                        scope: p.scope,
                        credentialId: p.credentialId,
                        userId: p.userId,
                        apiPath: p.apiPath,
                        hashAlgorithmOid: p.hashAlgorithmOid,
                        signAlgorithmOid: p.signAlgorithmOid,
                        sad: p.sad,
                        useAuthorizeEndpoint: p.useAuthorizeEndpoint,
                        authorizeAuthData: p.authorizeAuthData,
                        algorithms: algorithmPolicy(provider),
                    },
                    httpService,
                );
            }
            default: {
                const _exhaustive: never = type;
                throw new Error(
                    `Unknown KMS provider type: ${String(_exhaustive)}`,
                );
            }
        }
    }
}

/**
 * The provider's `algorithms` / `defaultAlgorithm`, or undefined when
 * neither is set so the adapter applies its own default.
 */
function algorithmPolicy(
    provider: KmsProviderConfig,
): KmsAlgorithmPolicy | undefined {
    if (!provider.algorithms && !provider.defaultAlgorithm) return undefined;
    return {
        algorithms: provider.algorithms,
        defaultAlgorithm: provider.defaultAlgorithm,
    };
}
