import {
    CONSTRAINT_SCHEMA_KEYWORDS,
    CONSTRAINT_SCHEMA_LIST_KEYWORDS,
    CONSTRAINT_SCHEMA_MAP_KEYWORDS,
    CONSTRAINT_VALUE_KEYWORDS,
} from "@eudiplo/config-format/claim-constraints.js";
import { z } from "zod";

// Claim field `constraints`: JSON Schema validation and annotation keywords
// only, recursively for subschemas (CredentialConfig v3). The keyword lists
// and the reasons live in @eudiplo/config-format.

const SubschemaSchema: z.ZodType<boolean | Record<string, unknown>> = z.lazy(
    () => z.union([z.boolean(), ClaimConstraintsSchema]),
);

export const ClaimConstraintsSchema: z.ZodType<Record<string, unknown>> = z
    .lazy(() =>
        z.strictObject(
            {
                ...Object.fromEntries(
                    CONSTRAINT_VALUE_KEYWORDS.map((keyword) => [
                        keyword,
                        z.unknown().optional(),
                    ]),
                ),
                ...Object.fromEntries(
                    CONSTRAINT_SCHEMA_KEYWORDS.map((keyword) => [
                        keyword,
                        SubschemaSchema.optional(),
                    ]),
                ),
                ...Object.fromEntries(
                    CONSTRAINT_SCHEMA_LIST_KEYWORDS.map((keyword) => [
                        keyword,
                        z.array(SubschemaSchema).optional(),
                    ]),
                ),
                ...Object.fromEntries(
                    CONSTRAINT_SCHEMA_MAP_KEYWORDS.map((keyword) => [
                        keyword,
                        z.record(z.string(), SubschemaSchema).optional(),
                    ]),
                ),
            },
            {
                error: (issue) =>
                    issue.code === "unrecognized_keys"
                        ? `Unsupported JSON Schema keyword(s) in constraints: ${issue.keys.join(", ")}`
                        : undefined,
            },
        ),
    )
    .meta({ id: "ClaimConstraints" });
