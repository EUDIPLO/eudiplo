import { LessThan, type Repository } from "typeorm";
import { type OidcSignIn, OidcSignInStatus } from "../domain/oidc-sign-in.js";
import type { OidcSignInEntity } from "../entities/oidc-sign-in.entity.js";
import type {
    OidcSignInChanges,
    OidcSignInRepository,
} from "../ports/oidc-sign-in.repository.js";

export class TypeOrmOidcSignInRepository implements OidcSignInRepository {
    constructor(private readonly signIns: Repository<OidcSignInEntity>) {}

    async insert(signIn: OidcSignIn): Promise<void> {
        await this.signIns.insert(this.signIns.create(signIn));
    }

    findForTenant(tenantId: string, id: string): Promise<OidcSignIn | null> {
        return this.signIns.findOneBy({ tenantId, id });
    }

    findAuthorizedByCode(
        tenantId: string,
        codeHash: string,
    ): Promise<OidcSignIn | null> {
        return this.signIns.findOneBy({
            tenantId,
            codeHash,
            status: OidcSignInStatus.Authorized,
        });
    }

    async transition(
        tenantId: string,
        id: string,
        from: OidcSignInStatus,
        changes: OidcSignInChanges,
    ): Promise<boolean> {
        const result = await this.signIns.update(
            { tenantId, id, status: from },
            changes,
        );
        return (result.affected ?? 0) > 0;
    }

    async deleteExpired(now: Date): Promise<number> {
        const result = await this.signIns.delete({ expiresAt: LessThan(now) });
        return result.affected ?? 0;
    }
}
