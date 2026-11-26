import type { Repository } from "typeorm";
import { insertNew } from "../../../../database/insert-new.js";
import { ResourceIdTaken } from "../../../../shared/domain/conflict-error.js";
import type { WebhookEndpointData } from "../domain/webhook-endpoint-data.js";
import type { WebhookEndpointEntity } from "../entities/webhook-endpoint.entity.js";
import type { WebhookEndpointRepository } from "../ports/webhook-endpoint.repository.js";

export class TypeOrmWebhookEndpointRepository
    implements WebhookEndpointRepository
{
    constructor(
        private readonly repository: Repository<WebhookEndpointEntity>,
    ) {}

    async listForTenant(tenantId: string): Promise<WebhookEndpointData[]> {
        return (await this.repository.find({ where: { tenantId } })).map(
            (config) => this.toData(config),
        );
    }

    async findForTenant(
        tenantId: string,
        id: string,
    ): Promise<WebhookEndpointData | null> {
        const config = await this.repository.findOneBy({ id, tenantId });
        return config ? this.toData(config) : null;
    }

    existsForTenant(tenantId: string, id: string): Promise<boolean> {
        return this.repository.existsBy({ id, tenantId });
    }

    async create(config: WebhookEndpointData): Promise<WebhookEndpointData> {
        return this.toData(
            await insertNew<WebhookEndpointEntity>(
                this.repository,
                config,
                { id: config.id, tenantId: config.tenantId },
                () => new ResourceIdTaken("Webhook endpoint", config.id),
            ),
        );
    }

    async save(config: WebhookEndpointData): Promise<WebhookEndpointData> {
        return this.toData(await this.repository.save(config));
    }

    async deleteForTenant(tenantId: string, id: string): Promise<void> {
        await this.repository.delete({ id, tenantId });
    }

    private toData(config: WebhookEndpointEntity): WebhookEndpointData {
        return {
            id: config.id,
            tenantId: config.tenantId,
            name: config.name,
            description: config.description,
            url: config.url,
            auth: config.auth,
        };
    }
}
