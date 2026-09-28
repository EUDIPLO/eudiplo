import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Column, Entity, OneToMany, PrimaryColumn } from "typeorm";
import { ClientEntity } from "../../client/entities/client.entity.js";
import { SessionStorageConfig } from "./session-storage-config.js";
import { StatusListConfig } from "./status-list-config.js";

export type TenantStatus = "active";

/**
 * Represents a tenant in the system.
 */
@Entity()
export class TenantEntity {
    /**
     * The unique identifier for the tenant.
     */
    @ApiProperty({ description: "Unique tenant identifier" })
    @PrimaryColumn()
    id!: string;

    /**
     * The name of the tenant.
     */
    @ApiProperty({ description: "Tenant display name" })
    @Column({ default: "EUDIPLO" })
    name!: string;

    /**
     * The description of the tenant.
     */
    @ApiPropertyOptional({
        description: "Tenant description",
        nullable: true,
    })
    @Column("varchar", { nullable: true })
    description?: string | null;

    /**
     * The current status of the tenant.
     */
    @ApiProperty({ description: "Tenant status", example: "active" })
    @Column("varchar", { nullable: true })
    status!: TenantStatus | null;

    /**
     * Session storage configuration for this tenant.
     * Controls how long sessions are kept and how they are cleaned up.
     */
    @ApiPropertyOptional({
        description:
            "Session storage configuration for this tenant. Controls TTL and cleanup behavior.",
        type: () => SessionStorageConfig,
    })
    @Column("json", { nullable: true })
    sessionConfig?: SessionStorageConfig | null;

    /**
     * Status list configuration for this tenant.
     * Controls the size and bits per status entry for newly created status lists.
     */
    @ApiPropertyOptional({
        description:
            "Status list configuration for this tenant. Only affects newly created status lists.",
        type: () => StatusListConfig,
    })
    @Column("json", { nullable: true })
    statusListConfig?: StatusListConfig | null;

    /**
     * The clients associated with the tenant.
     */
    @ApiPropertyOptional({
        description: "Clients associated with the tenant",
        type: () => [ClientEntity],
    })
    @OneToMany(
        () => ClientEntity,
        (client) => client.tenant,
    )
    clients!: ClientEntity[];
}
