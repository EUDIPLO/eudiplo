import type {
    DeepPartial,
    FindOptionsWhere,
    ObjectLiteral,
    Repository,
} from "typeorm";
import type { QueryDeepPartialEntity } from "typeorm/query-builder/QueryPartialEntity.js";

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
 * Stores a new row with one `INSERT`, never replacing a stored one as
 * `Repository.save` does. The primary key decides between concurrent
 * inserts of the same key, on SQLite and PostgreSQL alike.
 *
 * @param key - The row's primary key, checked when the insert hits a unique
 * constraint: when a row with this key exists, `taken()` is thrown, otherwise
 * the database error (another unique index) is rethrown.
 * @param taken - The error for a key that is already stored.
 * @returns The inserted entity with the columns the database generated.
 */
export async function insertNew<T extends ObjectLiteral>(
    repository: Repository<T>,
    values: DeepPartial<T>,
    key: FindOptionsWhere<T>,
    taken: () => Error,
): Promise<T> {
    const entity = repository.create(values);
    try {
        await repository.insert(entity as QueryDeepPartialEntity<T>);
    } catch (error) {
        if (isUniqueViolation(error) && (await repository.existsBy(key))) {
            throw taken();
        }
        throw error;
    }
    return entity;
}
