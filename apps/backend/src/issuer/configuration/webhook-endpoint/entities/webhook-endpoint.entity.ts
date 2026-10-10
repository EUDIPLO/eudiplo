import {
    ApiProperty,
    ApiPropertyOptional,
    getSchemaPath,
} from "@nestjs/swagger";
import { Column, Entity, ManyToOne, PrimaryColumn } from "typeorm";
import { TenantEntity } from "../../../../auth/tenant/entities/tenant.entity.js";
import { encryptedJsonPaths } from "../../../../platform/data-encryption/encrypted-column.transformer.js";
import {
    WebHookAuthConfigHeader,
    WebHookAuthConfigNone,
} from "../../../../webhook/webhook.dto.js";

/**
 * A Webhook Endpoint is a reusable notification target that receives
 * fire-and-forget event callbacks (e.g. credential_accepted / credential_failed).
 *
 * Webhook Endpoints are configured once per tenant and can be
 * referenced by credential configurations via `webhookEndpointId` or
 * per-offer via `webhookEndpointId` on the offer request.
 */
@Entity()
export class WebhookEndpointEntity {
    @ApiProperty({
        description: "Unique identifier for the webhook endpoint",
    })
    @PrimaryColumn("varchar")
    id!: string;

    @ApiProperty({ description: "Tenant identifier" })
    @Column("varchar", { primary: true })
    tenantId!: string;

    @ManyToOne(() => TenantEntity, { cascade: true, onDelete: "CASCADE" })
    tenant!: TenantEntity;

    @ApiProperty({ description: "Webhook endpoint name" })
    @Column("varchar")
    name!: string;

    @ApiPropertyOptional({ description: "Webhook endpoint description" })
    @Column("varchar", { nullable: true })
    description?: string | null;

    @ApiProperty({ description: "Webhook endpoint URL" })
    @Column("varchar")
    url!: string;

    @ApiProperty({
        oneOf: [
            { $ref: getSchemaPath(WebHookAuthConfigNone) },
            { $ref: getSchemaPath(WebHookAuthConfigHeader) },
        ],
    })
    // The API key is encrypted at rest.
    @Column("json", { transformer: encryptedJsonPaths("config.value") })
    auth!: WebHookAuthConfigNone | WebHookAuthConfigHeader;
}
