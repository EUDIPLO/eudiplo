import {
    ApiHideProperty,
    ApiProperty,
    ApiPropertyOptional,
} from "@nestjs/swagger";
import { Column, Entity, ManyToOne, PrimaryColumn } from "typeorm";
import { epochMilliseconds } from "../../../database/epoch-milliseconds.transformer.js";
import { Role } from "../../roles/role.enum.js";
import { TenantEntity } from "../../tenant/entities/tenant.entity.js";

/**
 * Represents a client in the system that belongs to a tenant.
 */
@Entity()
export class ClientEntity {
    /**
     * The unique identifier for the client.
     */
    @ApiProperty({ description: "Unique client identifier" })
    @PrimaryColumn("varchar")
    clientId!: string;

    /**
     * The secret key for the client.
     */
    @ApiHideProperty()
    @Column("varchar", { nullable: true })
    secret?: string;

    /**
     * The unique identifier for the tenant that the client belongs to. Only null for accounts that manage tenants, that do not belong to a client
     */
    @ApiPropertyOptional({
        description: "Tenant identifier the client belongs to",
    })
    @Column("varchar", { nullable: true })
    tenantId?: string;

    /**
     * The description of the client.
     */
    @ApiPropertyOptional({ description: "Client description" })
    @Column("varchar", { nullable: true })
    description?: string;

    /**
     * The roles assigned to the client.
     */
    @ApiProperty({
        description: "Roles assigned to the client",
        type: [String],
    })
    @Column({ type: "json" })
    roles!: Role[];

    /**
     * Optional list of presentation config IDs this client is allowed to use.
     * If null or empty, the client can use all presentation configs (backward compatible).
     * Only relevant if the client has the 'presentation:request' role.
     */
    @ApiPropertyOptional({
        type: [String],
        description:
            "List of presentation config IDs this client can use. If empty/null, all configs are allowed.",
        example: ["age-verification", "kyc-basic"],
    })
    @Column({ type: "json", nullable: true })
    allowedPresentationConfigs?: string[] | null;

    /**
     * Optional list of issuance config IDs this client is allowed to use.
     * If null or empty, the client can use all issuance configs (backward compatible).
     * Only relevant if the client has the 'issuance:offer' role.
     */
    @ApiPropertyOptional({
        type: [String],
        description:
            "List of issuance config IDs this client can use. If empty/null, all configs are allowed.",
        example: ["pid", "mdl"],
    })
    @Column({ type: "json", nullable: true })
    allowedIssuanceConfigs?: string[] | null;

    /**
     * When the client was created or got its current secret. Tokens of the
     * built-in OAuth2 server carry it as `credentials_at` and are rejected
     * when it no longer matches, so a re-created client or a new secret ends
     * older tokens. Null for clients created before 10.0: their tokens are
     * not limited.
     */
    @ApiHideProperty()
    @Column({
        type: "bigint",
        nullable: true,
        transformer: epochMilliseconds,
    })
    tokensValidAfter?: Date | null;

    /**
     * The tenant that the client belongs to.
     */
    @ApiHideProperty()
    @ManyToOne(
        () => TenantEntity,
        (tenant) => tenant.clients,
        { onDelete: "CASCADE" },
    )
    tenant?: TenantEntity;
}
