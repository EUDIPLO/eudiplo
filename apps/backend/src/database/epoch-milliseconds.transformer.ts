import type { ValueTransformer } from "typeorm";

/**
 * Stores an instant as milliseconds since the epoch in a `bigint` column, so
 * it reads back the same in every process: `timestamp` columns are read in
 * the process time zone on PostgreSQL.
 */
export const epochMilliseconds: ValueTransformer = {
    to: (value?: Date | null) =>
        value instanceof Date ? value.getTime() : value,
    from: (value?: string | number | null) =>
        value === null || value === undefined ? null : new Date(Number(value)),
};
