import { LessThan, LessThanOrEqual, type Repository } from "typeorm";
import { DpopProofJtiEntity } from "../entities/dpop-proof-jti.entity.js";
import type { DpopProofReplayRegistry } from "../ports/dpop-proof-replay-registry.js";

/** PostgreSQL `unique_violation` and the SQLite primary key/unique violations. */
const UNIQUE_VIOLATION_CODES = new Set([
    "23505",
    "SQLITE_CONSTRAINT_PRIMARYKEY",
    "SQLITE_CONSTRAINT_UNIQUE",
    "SQLITE_CONSTRAINT",
]);

function isUniqueViolation(error: unknown): boolean {
    const candidate = error as {
        code?: unknown;
        driverError?: { code?: unknown };
    };
    const code = candidate?.driverError?.code ?? candidate?.code;
    return typeof code === "string" && UNIQUE_VIOLATION_CODES.has(code);
}

/**
 * Stores presented DPoP proofs in `dpop_proof_jti`. Registration is one
 * INSERT whose primary key (jkt, jti) decides which of concurrent requests
 * wins, across all backend instances sharing the database.
 */
export class TypeOrmDpopProofReplayRegistry implements DpopProofReplayRegistry {
    constructor(private readonly proofs: Repository<DpopProofJtiEntity>) {}

    async register(
        jwkThumbprint: string,
        jti: string,
        expiresAt: Date,
    ): Promise<boolean> {
        // An expired entry no longer blocks the proof. Deleting it first keeps
        // the INSERT the only write that decides between concurrent requests.
        await this.proofs.delete({
            jkt: jwkThumbprint,
            jti,
            expiresAt: LessThanOrEqual(new Date()),
        });
        try {
            await this.proofs.insert({ jkt: jwkThumbprint, jti, expiresAt });
            return true;
        } catch (error) {
            if (isUniqueViolation(error)) {
                return false;
            }
            throw error;
        }
    }

    /** Remove entries that expired before the given time. */
    async deleteExpired(before: Date): Promise<void> {
        await this.proofs.delete({ expiresAt: LessThan(before) });
    }
}
