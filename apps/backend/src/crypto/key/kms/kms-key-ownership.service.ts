import { ConflictException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import { KeyChainEntity } from "../entities/key-chain.entity.js";
import type { KmsConfig } from "../schemas/kms-config.schema.js";
import { KmsConfigService } from "./kms-config.service.js";
import { tenantOwnsKmsProvider } from "./kms-tenant-restrictions.js";

type TenantKmsFile = Pick<KmsConfig, "providers"> | null | undefined;

/**
 * Keeps the keys of a KMS provider that tenants share with their tenant.
 *
 * A provider of the global `kms.json`, and a tenant provider that acts with
 * something of the instance, reaches the keys of every tenant that uses it
 * (tenantOwnsKmsProvider). Key chains name their key by a provider ID and a
 * key name or key ID, so a request must not be able to choose that pair
 * freely on such a provider.
 */
@Injectable()
export class KmsKeyOwnershipService {
    constructor(
        @InjectRepository(KeyChainEntity)
        private readonly keyChains: Repository<KeyChainEntity>,
        private readonly kmsConfigService: KmsConfigService,
    ) {}

    private readonly locks = new Map<string, Promise<unknown>>();

    /**
     * Run `task` alone among the tasks of the tenant in this process that
     * either bind a key of a KMS provider to a key chain or change which
     * provider an ID names. Both read the tenant's `kms.json`, call the
     * provider and write afterwards; interleaved, a key chain could be
     * stored for a provider that was the tenant's own when it was checked
     * and is shared when it is used. Not reentrant.
     *
     * Across processes, the requests that reach these tasks hold the
     * tenant's configuration lock (ConfigImportJournalService), which
     * refuses a second writer: bundle imports take it themselves, and
     * ConfigGenerationInterceptor takes it for the routes of
     * ConfigResourceRouteService and for key imports. A new caller needs a
     * route that takes it too. This lock also orders the tasks of one
     * request and the imports of a startup.
     */
    async exclusive<T>(tenantId: string, task: () => Promise<T>): Promise<T> {
        const previous = this.locks.get(tenantId) ?? Promise.resolve();
        const run = previous.then(task, task);
        const settled = run.catch(() => undefined);
        this.locks.set(tenantId, settled);
        try {
            return await run;
        } finally {
            if (this.locks.get(tenantId) === settled) {
                this.locks.delete(tenantId);
            }
        }
    }

    /**
     * Replace the tenant's `kms.json` for a request: `write` runs unless key
     * chains would lose a provider of their own (keyChainsLosingOwnProvider).
     *
     * @param next the file after the write, null when it is deleted
     * @throws ConflictException with the reason
     */
    replaceTenantFile<T>(
        tenantId: string,
        next: TenantKmsFile,
        write: () => T,
    ): Promise<T> {
        return this.exclusive(tenantId, async () => {
            const refusal = await this.keyChainsLosingOwnProvider(
                tenantId,
                next,
            );
            if (refusal) throw new ConflictException(refusal);
            return write();
        });
    }

    /**
     * The stored tenant file. One that is no valid KMS configuration gives
     * the tenant no provider; only the operator can store such a file, and
     * the tenant must stay able to replace or remove it. A valid file whose
     * providers do not load, for example after a variable was taken off
     * KMS_TENANT_VARIABLES, still says which providers are the tenant's own.
     */
    storedFile(tenantId: string): TenantKmsFile {
        try {
            return this.kmsConfigService.getTenantFile(tenantId);
        } catch {
            return null;
        }
    }

    /**
     * Why a request of the tenant may not attach these keys of the provider
     * to a key chain, or undefined. On a provider the tenant shares with
     * others it may only name keys its key chains on that provider already
     * hold; any other key may belong to another tenant. A provider the tenant
     * does not have is left to the check that reports it.
     *
     * @param tenantFile the tenant's `kms.json` the provider is taken from,
     * when it is not the stored one (a bundle that also writes the file)
     */
    async refusedExternalKeys(
        tenantId: string,
        providerId: string,
        externalKeyIds: readonly string[],
        tenantFile: TenantKmsFile = this.storedFile(tenantId),
    ): Promise<string | undefined> {
        if (tenantOwnsKmsProvider(tenantFile, providerId)) return undefined;
        const shared = this.kmsConfigService
            .getConfig()
            .providers.some((provider) => provider.id === providerId);
        const inTenantFile = (tenantFile?.providers ?? []).some(
            (provider) => provider.id === providerId,
        );
        if (!shared && !inTenantFile) return undefined;

        const held = new Set<string>();
        for (const keyChain of await this.keyChains.find({
            where: { tenantId, kmsProvider: providerId },
            select: { id: true, externalKeyId: true, rootExternalKeyId: true },
        })) {
            if (keyChain.externalKeyId) held.add(keyChain.externalKeyId);
            if (keyChain.rootExternalKeyId) {
                held.add(keyChain.rootExternalKeyId);
            }
        }
        const foreign = externalKeyIds.find((id) => !held.has(id));
        if (foreign === undefined) return undefined;
        return `External KMS key '${foreign}' is not a key of this tenant on KMS provider '${providerId}', which the tenant shares with other tenants. A request can only refer to a key that a key chain of the tenant already holds on such a provider. To use another key, the operator adds the key chain to the tenant's configuration folder.`;
    }

    /**
     * Why a request may not replace the tenant's `kms.json` with `next`
     * (null: delete it), or undefined. A provider only the tenant can act as
     * must stay one while key chains of the tenant use it: without it they
     * would resolve the same provider ID to a provider other tenants use, now
     * or when the operator adds one with that ID, and
     * the key names the tenant chose for its own provider could be keys of
     * another tenant there. Used by replaceTenantFile and by plans.
     */
    async keyChainsLosingOwnProvider(
        tenantId: string,
        next: TenantKmsFile,
    ): Promise<string | undefined> {
        const stored = this.storedFile(tenantId);
        const global = this.kmsConfigService.getConfig().providers;
        const lost = (stored?.providers ?? [])
            .map((provider) => provider.id)
            .filter((id) => {
                if (!tenantOwnsKmsProvider(stored, id)) return false;
                if (tenantOwnsKmsProvider(next, id)) return false;
                const after =
                    (next?.providers ?? []).find((p) => p.id === id) ??
                    global.find((p) => p.id === id);
                // Also without a provider of that ID afterwards: one that is
                // added later would take the key chains over. Keys held in
                // the database row name no key of a provider.
                const before = stored?.providers.find((p) => p.id === id);
                return (after ?? before)?.type !== "db";
            });
        if (lost.length === 0) return undefined;
        const using = await this.keyChains.find({
            where: { tenantId, kmsProvider: In(lost) },
            select: { id: true, kmsProvider: true },
            order: { id: "ASC" },
        });
        if (using.length === 0) return undefined;
        const provider = using[0].kmsProvider;
        const ids = using
            .filter((keyChain) => keyChain.kmsProvider === provider)
            .map((keyChain) => `'${keyChain.id}'`)
            .join(", ");
        return `KMS provider '${provider}' of the tenant's configuration holds the keys of key chain ${ids}. Without it, these key chains would use a provider '${provider}' that other tenants use too, now or once one with that ID exists. Delete the key chains first, or keep the provider with its own credentials.`;
    }
}
