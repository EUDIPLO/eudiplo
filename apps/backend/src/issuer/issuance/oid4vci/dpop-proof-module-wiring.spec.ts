import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { describe, expect, it, vi } from "vitest";
import { DpopProofJtiCleanupJob } from "./adapters/dpop-proof-jti-cleanup.job.js";
import { TypeOrmDpopProofReplayRegistry } from "./adapters/typeorm-dpop-proof-replay-registry.js";
import { dpopProofProviders } from "./dpop-proof.module.js";
import { DpopProofJtiEntity } from "./entities/dpop-proof-jti.entity.js";
import { DPOP_PROOF_REPLAY_REGISTRY } from "./ports/dpop-proof-replay-registry.js";

describe("DpopProofModule wiring", () => {
    it("binds the replay registry port and the cleanup job to the TypeORM adapter", async () => {
        const repository = {
            delete: vi.fn().mockResolvedValue({ affected: 0 }),
            insert: vi.fn().mockResolvedValue({}),
        };
        const moduleRef = await Test.createTestingModule({
            providers: [
                ...dpopProofProviders,
                {
                    provide: getRepositoryToken(DpopProofJtiEntity),
                    useValue: repository,
                },
            ],
        }).compile();

        const registry = moduleRef.get(DPOP_PROOF_REPLAY_REGISTRY);
        expect(registry).toBeInstanceOf(TypeOrmDpopProofReplayRegistry);
        expect(registry).toBe(moduleRef.get(TypeOrmDpopProofReplayRegistry));
        await expect(
            registry.register("jkt", "jti", new Date(Date.now() + 60_000)),
        ).resolves.toBe(true);
        expect(repository.insert).toHaveBeenCalledWith(
            expect.objectContaining({ jkt: "jkt", jti: "jti" }),
        );

        moduleRef.get(DpopProofJtiCleanupJob).cleanup();
        await vi.waitFor(() =>
            expect(repository.delete).toHaveBeenCalledTimes(2),
        );
    });
});
