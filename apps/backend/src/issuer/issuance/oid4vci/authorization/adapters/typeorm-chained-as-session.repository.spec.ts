import type { Repository } from "typeorm";
import { describe, expect, it, vi } from "vitest";
import type { ChainedAsSessionEntity } from "../shared/entities/chained-as-session.entity.js";
import { TypeOrmChainedAsSessionRepository } from "./typeorm-chained-as-session.repository.js";

describe("TypeOrmChainedAsSessionRepository", () => {
    it("scopes the issuer_state lookup to the tenant", async () => {
        const findOne = vi.fn().mockResolvedValue(null);
        const repository = new TypeOrmChainedAsSessionRepository({
            findOne,
        } as unknown as Repository<ChainedAsSessionEntity>);

        await repository.findByIssuerState("tenant-1", "issuer-state");

        expect(findOne).toHaveBeenCalledWith({
            where: { tenantId: "tenant-1", issuerState: "issuer-state" },
        });
    });
});
