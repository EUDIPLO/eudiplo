import type { Repository } from "typeorm";
import type { OidcClient, OidcClientSecret } from "../domain/oidc-client.js";
import type {
    OidcClientEntity,
    StoredOidcClientSecret,
} from "../entities/oidc-client.entity.js";
import type { OidcClientRepository } from "../ports/oidc-client.repository.js";

const toDate = (value?: string | null) => (value ? new Date(value) : null);

export class TypeOrmOidcClientRepository implements OidcClientRepository {
    constructor(private readonly clients: Repository<OidcClientEntity>) {}

    async listForTenant(tenantId: string): Promise<OidcClient[]> {
        const entities = await this.clients.find({
            where: { tenantId },
            order: { createdAt: "ASC" },
        });
        return entities.map(toDomain);
    }

    async findForTenant(
        tenantId: string,
        id: string,
    ): Promise<OidcClient | null> {
        const entity = await this.clients.findOneBy({ tenantId, id });
        return entity ? toDomain(entity) : null;
    }

    async existsForTenant(tenantId: string): Promise<boolean> {
        return this.clients.existsBy({ tenantId });
    }

    async listUsingPresentationConfig(
        tenantId: string,
        presentationConfigId: string,
    ): Promise<OidcClient[]> {
        // Scopes are a JSON column; a tenant has few clients.
        return (await this.listForTenant(tenantId)).filter((client) =>
            client.scopes.some(
                (scope) => scope.presentationConfigId === presentationConfigId,
            ),
        );
    }

    async save(client: OidcClient): Promise<OidcClient> {
        const saved = await this.clients.save(
            this.clients.create({
                id: client.id,
                tenantId: client.tenantId,
                name: client.name,
                redirectUris: client.redirectUris,
                profile: client.profile,
                scopes: client.scopes,
                secrets: client.secrets.map(toStored),
            }),
        );
        return toDomain(saved);
    }

    async deleteForTenant(tenantId: string, id: string): Promise<void> {
        await this.clients.delete({ tenantId, id });
    }

    async recordSecretUse(
        tenantId: string,
        clientId: string,
        secretId: string,
        at: Date,
    ): Promise<void> {
        const entity = await this.clients.findOneBy({ tenantId, id: clientId });
        if (!entity) return;
        const secrets = entity.secrets.map((secret) =>
            secret.id === secretId
                ? { ...secret, lastUsedAt: at.toISOString() }
                : secret,
        );
        // Only the secrets column, so a concurrent edit of the rest survives.
        await this.clients.update({ tenantId, id: clientId }, { secrets });
    }
}

function toStored(secret: OidcClientSecret): StoredOidcClientSecret {
    return {
        id: secret.id,
        hash: secret.hash,
        createdAt: secret.createdAt.toISOString(),
        expiresAt: secret.expiresAt?.toISOString() ?? null,
        lastUsedAt: secret.lastUsedAt?.toISOString() ?? null,
    };
}

function toDomain(entity: OidcClientEntity): OidcClient {
    return {
        id: entity.id,
        tenantId: entity.tenantId,
        name: entity.name,
        redirectUris: entity.redirectUris ?? [],
        profile: entity.profile,
        scopes: entity.scopes ?? [],
        secrets: (entity.secrets ?? []).map((secret) => ({
            id: secret.id,
            hash: secret.hash,
            createdAt: new Date(secret.createdAt),
            expiresAt: toDate(secret.expiresAt),
            lastUsedAt: toDate(secret.lastUsedAt),
        })),
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
    };
}
