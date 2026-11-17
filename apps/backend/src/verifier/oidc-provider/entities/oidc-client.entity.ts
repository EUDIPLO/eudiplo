import {
    Column,
    CreateDateColumn,
    Entity,
    ManyToOne,
    PrimaryColumn,
    UpdateDateColumn,
} from "typeorm";
import { TenantEntity } from "../../../auth/tenant/entities/tenant.entity.js";
import type { SubjectClaim } from "../domain/presented-claims.js";

/** A client secret as stored: only its hash, dates as ISO strings. */
export interface StoredOidcClientSecret {
    id: string;
    hash: string;
    createdAt: string;
    expiresAt?: string | null;
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

    /**
     * Last use per secret ID, ISO strings. A column of its own: recording a
     * use never writes `secrets`, so it cannot bring back a deleted secret.
     */
    @Column("json", { nullable: true })
    secretLastUsed?: Record<string, string> | null;

    /** Claim whose pairwise hash becomes `sub`; null for a new one per sign-in. */
    @Column("json", { nullable: true })
    subject?: SubjectClaim | null;

    /** Credential query whose claims are copied to the token's top level. */
    @Column("varchar", { nullable: true })
    claimsFrom?: string | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
