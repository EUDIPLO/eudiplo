import type { Repository } from "typeorm";
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
