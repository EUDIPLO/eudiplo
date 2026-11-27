import { Inject, Injectable } from "@nestjs/common";
import type { AuditLogRequestMeta } from "../../audit-log/audit-log.service.js";
import { AuditLogService } from "../../audit-log/audit-log.service.js";
import {
    getChangedFields,
    resolveAuditActor,
} from "../../audit-log/audit-log-context.util.js";
import type { TokenPayload } from "../../auth/token.decorator.js";
import { ResourceIdTaken } from "../../shared/domain/conflict-error.js";
import { FederationTrustAnchorReferences } from "./application/federation-trust-anchor-references.js";
import type { FederationTrustAnchorData } from "./domain/federation-trust-anchor-data.js";
import {
    FederationTrustAnchorConflict,
    FederationTrustAnchorNotFound,
} from "./domain/federation-trust-anchor-errors.js";
import {
    type FederationTrustAnchorChange,
    FederationTrustAnchorInUseError,
} from "./domain/federation-trust-anchor-reference.js";
import {
    FEDERATION_TRUST_ANCHOR_REPOSITORY,
    type FederationTrustAnchorRepository,
} from "./ports/federation-trust-anchor.repository.js";
import type {
    CreateFederationTrustAnchor,
    UpdateFederationTrustAnchor,
} from "./schemas/federation-trust-anchor.schema.js";

/** Options of a change to a trust anchor. */
export interface FederationTrustAnchorChangeOptions {
    /**
     * Refuse the change while a configuration of the tenant names the
     * anchor's entity ID (default). A configuration import turns it off: its
     * plan checks the configurations that survive the import, and checking
     * here would refuse an anchor whose referencing configuration the import
     * rewrites or deletes in a later step.
     */
    checkReferences?: boolean;
}

/**
 * Manages a tenant's OpenID Federation trust anchors and their pinned
 * federation keys. Each entity ID is registered at most once per tenant.
 * An anchor whose entity ID a configuration names is neither deleted nor
 * given another entity ID.
 */
@Injectable()
export class FederationTrustAnchorService {
    constructor(
        @Inject(FEDERATION_TRUST_ANCHOR_REPOSITORY)
        private readonly repo: FederationTrustAnchorRepository,
        private readonly auditLog: AuditLogService,
        private readonly references: FederationTrustAnchorReferences,
    ) {}

    getAll(tenantId: string) {
        return this.repo.listForTenant(tenantId);
    }

    async getById(tenantId: string, id: string) {
        const anchor = await this.repo.findForTenant(tenantId, id);
        if (!anchor) {
            throw new FederationTrustAnchorNotFound(id);
        }
        return anchor;
    }

    /**
     * The entity IDs among `entityIds` the tenant has not registered as
     * trust anchors. A configuration naming one is rejected: without pinned
     * keys it would never be trusted.
     */
    async unregistered(
        tenantId: string,
        entityIds: readonly string[],
    ): Promise<string[]> {
        const unique = [...new Set(entityIds)];
        if (unique.length === 0) return [];
        const registered = new Set(
            (await this.repo.findByEntityIds(tenantId, unique)).map(
                (anchor) => anchor.entityId,
            ),
        );
        return unique.filter((id) => !registered.has(id));
    }

    async create(
        tenantId: string,
        dto: CreateFederationTrustAnchor,
        actorToken?: TokenPayload,
        requestMeta?: AuditLogRequestMeta,
    ) {
        if (await this.repo.existsForTenant(tenantId, dto.id)) {
            throw new ResourceIdTaken("Federation trust anchor", dto.id);
        }
        await this.assertEntityIdFree(tenantId, dto.entityId, dto.id);
        let saved: FederationTrustAnchorData;
        try {
            saved = await this.repo.create({ ...dto, tenantId });
        } catch (error) {
            // A concurrent create registered the entity ID first: its unique
            // index refused this insert.
            if (!(error instanceof ResourceIdTaken)) {
                await this.assertEntityIdFree(tenantId, dto.entityId, dto.id);
            }
            throw error;
        }
        if (actorToken) {
            await this.auditLog.record({
                tenantId,
                actionType: "federation_trust_anchor_created",
                actor: resolveAuditActor(actorToken),
                changedFields: getChangedFields(undefined, forLog(saved)),
                after: forLog(saved),
                requestMeta,
            });
        }
        return saved;
    }

    async update(
        tenantId: string,
        id: string,
        dto: UpdateFederationTrustAnchor,
        actorToken?: TokenPayload,
        requestMeta?: AuditLogRequestMeta,
        { checkReferences = true }: FederationTrustAnchorChangeOptions = {},
    ) {
        const existing = await this.getById(tenantId, id);
        if (dto.entityId !== undefined && dto.entityId !== existing.entityId) {
            await this.assertEntityIdFree(tenantId, dto.entityId, id);
            if (checkReferences) {
                await this.assertUnreferenced(existing, "change-entity-id");
            }
        }
        const saved = await this.repo.save({
            ...existing,
            ...dto,
            id,
            tenantId,
        });
        if (actorToken) {
            await this.auditLog.record({
                tenantId,
                actionType: "federation_trust_anchor_updated",
                actor: resolveAuditActor(actorToken),
                changedFields: getChangedFields(
                    forLog(existing),
                    forLog(saved),
                ),
                before: forLog(existing),
                after: forLog(saved),
                requestMeta,
            });
        }
        return saved;
    }

    async delete(
        tenantId: string,
        id: string,
        actorToken?: TokenPayload,
        requestMeta?: AuditLogRequestMeta,
        { checkReferences = true }: FederationTrustAnchorChangeOptions = {},
    ) {
        const existing = await this.getById(tenantId, id);
        if (checkReferences) {
            await this.assertUnreferenced(existing, "delete");
        }
        await this.repo.deleteForTenant(tenantId, id);
        if (actorToken) {
            await this.auditLog.record({
                tenantId,
                actionType: "federation_trust_anchor_deleted",
                actor: resolveAuditActor(actorToken),
                before: forLog(existing),
                requestMeta,
            });
        }
    }

    /**
     * Not atomic: a configuration saved between this lookup and the change
     * can still name the entity ID. Accepted for administrative CRUD; that
     * configuration's trust anchor is then not trusted until registered.
     */
    private async assertUnreferenced(
        anchor: FederationTrustAnchorData,
        change: FederationTrustAnchorChange,
    ) {
        const references = await this.references.find(
            anchor.tenantId,
            anchor.entityId,
        );
        if (references.length > 0) {
            throw new FederationTrustAnchorInUseError(
                anchor.id,
                anchor.entityId,
                change,
                references,
            );
        }
    }

    private async assertEntityIdFree(
        tenantId: string,
        entityId: string,
        id: string,
    ) {
        const [other] = (
            await this.repo.findByEntityIds(tenantId, [entityId])
        ).filter((anchor) => anchor.id !== id);
        if (other) {
            throw new FederationTrustAnchorConflict(
                `Trust anchor ${entityId} is already registered as '${other.id}'`,
            );
        }
    }
}

function forLog(anchor: FederationTrustAnchorData): Record<string, unknown> {
    return {
        id: anchor.id,
        entityId: anchor.entityId,
        description: anchor.description,
        jwks: anchor.jwks,
    };
}
