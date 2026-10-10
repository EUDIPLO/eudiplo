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
 * An Attribute Provider is an external HTTPS endpoint called during
 * credential issuance to dynamically fetch claim values.
 *
 * Attribute Providers are configured once per tenant and can be
 * referenced by multiple credential configurations via `attributeProviderId`.
 */
@Entity()
export class AttributeProviderEntity {
    @PrimaryColumn("varchar")
    id!: string;

    @ApiProperty({ description: "Tenant identifier" })
    @Column("varchar", { primary: true })
    tenantId!: string;

    @ManyToOne(() => TenantEntity, { cascade: true, onDelete: "CASCADE" })
    tenant!: TenantEntity;

    @ApiProperty({ description: "Attribute provider name" })
    @Column("varchar")
    name!: string;

    @ApiPropertyOptional({ description: "Attribute provider description" })
    @Column("varchar", { nullable: true })
    description?: string | null;

    @ApiProperty({ description: "Attribute provider URL" })
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
