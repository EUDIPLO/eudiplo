import { ConflictException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { type EntityManager, Repository } from "typeorm";
import type {
    ConfigOwnership,
    ConfigResourceKind,
} from "./config-resource.types.js";
import { ConfigResourceMetadataEntity } from "./entities/config-resource-metadata.entity.js";

@Injectable()
export class ConfigOwnershipService {
    constructor(
        @InjectRepository(ConfigResourceMetadataEntity)
        private readonly repository: Repository<ConfigResourceMetadataEntity>,
    ) {}

    async get(
        tenantId: string,
        kind: ConfigResourceKind,
        resourceId: string,
    ): Promise<ConfigResourceMetadataEntity> {
        return (
            (await this.repository.findOneBy({ tenantId, kind, resourceId })) ??
            this.repository.create({
                tenantId,
                kind,
                resourceId,
                ownership: "unmanaged",
                generation: 1,
            })
        );
    }

    findStored(
        tenantId: string,
        kind: ConfigResourceKind,
        resourceId: string,
    ): Promise<ConfigResourceMetadataEntity | null> {
        return this.repository.findOneBy({ tenantId, kind, resourceId });
    }

    list(tenantId: string): Promise<ConfigResourceMetadataEntity[]> {
        return this.repository.find({
            where: { tenantId },
            order: { kind: "ASC", resourceId: "ASC" },
        });
    }

    listManagedBySource(
        tenantId: string,
        source: string,
    ): Promise<ConfigResourceMetadataEntity[]> {
        return this.repository.find({
            where: { tenantId, ownership: "file-managed", source },
            order: { kind: "ASC", resourceId: "ASC" },
        });
    }

    async listManagedBySourceScope(
        tenantId: string,
        source: string,
    ): Promise<ConfigResourceMetadataEntity[]> {
        const managed = await this.list(tenantId);
        return managed.filter(
            (entry) =>
                entry.ownership === "file-managed" &&
                sourceInScope(entry.source, source),
        );
    }

    async markApplied(
        options: {
            tenantId: string;
            kind: ConfigResourceKind;
            resourceId: string;
            ownership: ConfigOwnership;
            generation?: number;
            source?: string;
            sourceHash?: string;
        },
        manager?: EntityManager,
        allowGenerationReset = false,
    ): Promise<ConfigResourceMetadataEntity> {
        const repository =
            manager?.getRepository(ConfigResourceMetadataEntity) ??
            this.repository;
        const current =
            (await repository.findOneBy({
                tenantId: options.tenantId,
                kind: options.kind,
                resourceId: options.resourceId,
            })) ?? repository.create({ ...options, generation: 1 });
        if (
            !allowGenerationReset &&
            options.ownership === "file-managed" &&
            options.generation !== undefined &&
            options.generation < current.generation
        ) {
            throw new ConflictException(
                `${options.kind} '${options.resourceId}' has stale generation ${options.generation}; stored generation is ${current.generation}.`,
            );
        }
        return repository.save({
            ...current,
            ...options,
            generation: options.generation ?? current.generation ?? 1,
            lastAppliedAt: new Date(),
        });
    }

    /** Keeps the former source so imports from it can skip the resource until reattached. */
    async detach(
        tenantId: string,
        kind: ConfigResourceKind,
        resourceId: string,
    ): Promise<ConfigResourceMetadataEntity> {
        const current = await this.get(tenantId, kind, resourceId);
        if (current.ownership === "detached") return current;
        if (current.ownership !== "file-managed") {
            throw new ConflictException(
                `${kind} '${resourceId}' is not file-managed and cannot be detached.`,
            );
        }
        return this.repository.save({
            ...current,
            ownership: "detached",
            sourceHash: undefined,
            lastAppliedAt: new Date(),
        });
    }

    async assertMutable(
        tenantId: string,
        kind: ConfigResourceKind,
        resourceId: string,
    ): Promise<void> {
        const metadata = await this.repository.findOneBy({
            tenantId,
            kind,
            resourceId,
        });
        if (metadata?.ownership === "file-managed") {
            throw new ConflictException(
                `${kind} '${resourceId}' is file-managed by ${metadata.source ?? "provisioning"}. Detach it before changing it through the API or UI.`,
            );
        }
    }

    async recordApiMutation(
        tenantId: string,
        kind: ConfigResourceKind,
        resourceId: string,
        create: boolean,
    ): Promise<ConfigResourceMetadataEntity> {
        const stored = await this.repository.findOneBy({
            tenantId,
            kind,
            resourceId,
        });
        // A detached resource stays detached, so its former source keeps skipping it.
        const detached = stored?.ownership === "detached";
        return this.repository.save({
            ...(stored ?? { tenantId, kind, resourceId }),
            ownership: detached ? "detached" : "unmanaged",
            generation: create && !stored ? 1 : (stored?.generation ?? 1) + 1,
            source: detached ? stored.source : undefined,
            sourceHash: undefined,
        });
    }

    async remove(
        tenantId: string,
        kind: ConfigResourceKind,
        resourceId: string,
    ): Promise<void> {
        await this.repository.delete({ tenantId, kind, resourceId });
    }

    async removeTenant(tenantId: string): Promise<void> {
        await this.repository.delete({ tenantId });
    }
}

/**
 * Whether a stored ownership source belongs to an import source. A folder
 * source also covers sources recorded for files below that folder.
 */
export function sourceInScope(
    entrySource: string | undefined,
    source: string,
): boolean {
    if (!entrySource) return false;
    if (entrySource === source) return true;
    if (!source.startsWith("folder:")) return false;
    let folder = source.slice("folder:".length);
    while (folder.endsWith("/") || folder.endsWith("\\")) {
        folder = folder.slice(0, -1);
    }
    return (
        entrySource.startsWith(`${folder}/`) ||
        entrySource.startsWith(`${folder}\\`)
    );
}
