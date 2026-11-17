import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    ManyToOne,
    PrimaryColumn,
} from "typeorm";
import { TenantEntity } from "../../../auth/tenant/entities/tenant.entity.js";
import type { OidcSignIn, OidcSignInStatus } from "../domain/oidc-sign-in.js";

/** A sign-in of a relying party, from the pushed request to the ID token. */
@Entity("oidc_sign_in")
@Index("IDX_oidc_sign_in_code", ["tenantId", "codeHash"])
@Index("IDX_oidc_sign_in_expires", ["expiresAt"])
export class OidcSignInEntity implements OidcSignIn {
    @PrimaryColumn("varchar")
    id!: string;

    @Column("varchar")
    tenantId!: string;

    @ManyToOne(() => TenantEntity, { onDelete: "CASCADE" })
    tenant?: TenantEntity;

    @Column("varchar")
    clientId!: string;

    @Column("varchar")
    redirectUri!: string;

    @Column("varchar", { nullable: true })
    state?: string | null;

    @Column("varchar", { nullable: true })
    nonce?: string | null;

    @Column("varchar")
    scope!: string;

    @Column("varchar")
    presentationConfigId!: string;

    @Column("varchar")
    codeChallenge!: string;

    @Column("boolean", { default: false })
    requireSameDevice!: boolean;

    @Column("varchar")
    status!: OidcSignInStatus;

    @Column("varchar", { nullable: true })
    browserBindingHash?: string | null;

    @Column("varchar", { nullable: true })
    presentationSessionId?: string | null;

    @Column("text", { nullable: true })
    sameDeviceRequest?: string | null;

    @Column("text", { nullable: true })
    crossDeviceRequest?: string | null;

    @Column("boolean", { default: false })
    walletReturnedElsewhere!: boolean;

    @Column("varchar", { nullable: true })
    codeHash?: string | null;

    @Column({ type: Date, nullable: true })
    codeExpiresAt?: Date | null;

    @Column("varchar", { nullable: true })
    acr?: string | null;

    @Column({ type: Date, nullable: true })
    authTime?: Date | null;

    @Column({ type: Date })
    expiresAt!: Date;

    @CreateDateColumn()
    createdAt!: Date;
}
