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
                subject: client.subject ?? null,
                claimsFrom: client.claimsFrom ?? null,
            }),
        );
        // Read back, so the result carries the last use of each secret,
        // which save leaves to its own column.
        return (
            (await this.findForTenant(client.tenantId, client.id)) ??
            toDomain(saved)
        );
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
        const entity = await this.clients.findOne({
            where: { tenantId, id: clientId },
            select: { id: true, tenantId: true, secretLastUsed: true },
        });
        if (!entity) return;
        // Only this column: a concurrent change of the secrets survives, and
        // a lost update here only loses a timestamp.
        await this.clients.update(
            { tenantId, id: clientId },
            {
                secretLastUsed: {
                    ...(entity.secretLastUsed ?? {}),
                    [secretId]: at.toISOString(),
                },
            },
        );
    }
}

function toStored(secret: OidcClientSecret): StoredOidcClientSecret {
    return {
        id: secret.id,
        hash: secret.hash,
        createdAt: secret.createdAt.toISOString(),
        expiresAt: secret.expiresAt?.toISOString() ?? null,
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
            lastUsedAt: toDate(entity.secretLastUsed?.[secret.id]),
        })),
        subject: entity.subject ?? null,
        claimsFrom: entity.claimsFrom ?? null,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
    };
}
