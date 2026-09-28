import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { CredentialNonceCleanupJob } from "./adapters/credential-nonce-cleanup.job.js";
import { TypeOrmCredentialNonceRepository } from "./adapters/typeorm-credential-nonce.repository.js";
import { ValidateAndConsumeCredentialNonces } from "./application/validate-and-consume-credential-nonces.js";
import { NonceEntity } from "./entities/nonces.entity.js";
import {
    CREDENTIAL_NONCE_REPOSITORY,
    type CredentialNonceRepository,
} from "./ports/credential-nonce.repository.js";

@Module({
    imports: [TypeOrmModule.forFeature([NonceEntity])],
    providers: [
        CredentialNonceCleanupJob,
        {
            provide: ValidateAndConsumeCredentialNonces,
            inject: [CREDENTIAL_NONCE_REPOSITORY],
            useFactory: (nonces: CredentialNonceRepository) =>
                new ValidateAndConsumeCredentialNonces(nonces),
        },
        {
            provide: CREDENTIAL_NONCE_REPOSITORY,
            useClass: TypeOrmCredentialNonceRepository,
        },
    ],
    exports: [CREDENTIAL_NONCE_REPOSITORY, ValidateAndConsumeCredentialNonces],
})
export class CredentialNonceModule {}
