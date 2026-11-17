import {
    Column,
    CreateDateColumn,
    Entity,
    ManyToOne,
    PrimaryColumn,
    UpdateDateColumn,
} from "typeorm";
import { TenantEntity } from "../../../auth/tenant/entities/tenant.entity.js";

/** A client secret as stored: only its hash, dates as ISO strings. */
export interface StoredOidcClientSecret {
    id: string;
    hash: string;
    createdAt: string;
    expiresAt?: string | null;
    lastUsedAt?: string | null;
}

/** A relying party of the tenant's OpenID Provider. */
@Entity("oidc_client")
export class OidcClientEntity {
    /** The `client_id`. */
    @PrimaryColumn("varchar")
    id!: string;

    @PrimaryColumn("varchar")
    tenantId!: string;

    @ManyToOne(() => TenantEntity, { onDelete: "CASCADE" })
    tenant?: TenantEntity;

    @Column("varchar")
    name!: string;

    @Column("json")
    redirectUris!: string[];

    @Column("varchar")
    profile!: "secure" | "basic";

    @Column("json")
    scopes!: { scope: string; presentationConfigId: string }[];

    @Column("json")
    secrets!: StoredOidcClientSecret[];

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
