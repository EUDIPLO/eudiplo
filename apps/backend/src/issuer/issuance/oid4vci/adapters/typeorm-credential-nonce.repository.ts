import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThan, Repository } from "typeorm";
import { NonceEntity } from "../entities/nonces.entity.js";
import {
    type CredentialNonce,
    type CredentialNonceRepository,
} from "../ports/credential-nonce.repository.js";

@Injectable()
export class TypeOrmCredentialNonceRepository
    implements CredentialNonceRepository
{
    constructor(
        @InjectRepository(NonceEntity)
        private readonly nonces: Repository<NonceEntity>,
    ) {}

    async save(nonce: CredentialNonce): Promise<void> {
        await this.nonces.save(nonce);
    }

    find(tenantId: string, nonce: string): Promise<CredentialNonce | null> {
        return this.nonces.findOneBy({ tenantId, nonce });
    }

    async delete(tenantId: string, nonce: string): Promise<boolean> {
        const result = await this.nonces.delete({ tenantId, nonce });
        return (result.affected ?? 0) > 0;
    }

    async deleteExpired(before: Date): Promise<void> {
        await this.nonces.delete({ expiresAt: LessThan(before) });
    }
}
