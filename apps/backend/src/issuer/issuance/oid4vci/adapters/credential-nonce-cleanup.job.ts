import { Inject, Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
    CREDENTIAL_NONCE_REPOSITORY,
    type CredentialNonceRepository,
} from "../ports/credential-nonce.repository.js";

@Injectable()
export class CredentialNonceCleanupJob {
    constructor(
        @Inject(CREDENTIAL_NONCE_REPOSITORY)
        private readonly nonces: CredentialNonceRepository,
    ) {}

    @Cron(CronExpression.EVERY_10_MINUTES)
    cleanup(): void {
        void this.nonces.deleteExpired(new Date());
    }
}
