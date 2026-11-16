import type { ValueTransformer } from "typeorm";

/** PostgreSQL returns every `bigint` as a string; read it as a number. */
export const wholeNumber: ValueTransformer = {
    to: (value?: number | null) => value,
    from: (value?: string | number | null) =>
        value === null || value === undefined ? value : Number(value),
};
