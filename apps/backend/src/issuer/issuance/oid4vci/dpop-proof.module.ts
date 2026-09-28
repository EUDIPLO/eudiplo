import { Module } from "@nestjs/common";
import { getRepositoryToken, TypeOrmModule } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { DpopProofJtiCleanupJob } from "./adapters/dpop-proof-jti-cleanup.job.js";
import { TypeOrmDpopProofReplayRegistry } from "./adapters/typeorm-dpop-proof-replay-registry.js";
import { DpopProofJtiEntity } from "./entities/dpop-proof-jti.entity.js";
import { DPOP_PROOF_REPLAY_REGISTRY } from "./ports/dpop-proof-replay-registry.js";

/** Composition of the DPoP proof replay registry and its cleanup job. */
export const dpopProofProviders = [
    {
        provide: TypeOrmDpopProofReplayRegistry,
        inject: [getRepositoryToken(DpopProofJtiEntity)],
        useFactory: (repository: Repository<DpopProofJtiEntity>) =>
            new TypeOrmDpopProofReplayRegistry(repository),
    },
    {
        provide: DPOP_PROOF_REPLAY_REGISTRY,
        useExisting: TypeOrmDpopProofReplayRegistry,
    },
    DpopProofJtiCleanupJob,
];

/**
 * DPoP proof replay protection (RFC 9449 Section 11.1), shared by the token,
 * PAR and credential issuer resource endpoints.
 */
@Module({
    imports: [TypeOrmModule.forFeature([DpopProofJtiEntity])],
    providers: dpopProofProviders,
    exports: [DPOP_PROOF_REPLAY_REGISTRY],
})
export class DpopProofModule {}
