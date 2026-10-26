import {
    CONSTRAINT_SCHEMA_KEYWORDS,
    CONSTRAINT_SCHEMA_LIST_KEYWORDS,
    CONSTRAINT_SCHEMA_MAP_KEYWORDS,
    CONSTRAINT_VALUE_KEYWORDS,
} from "@eudiplo/config-format/claim-constraints.js";
import {
    claimPatternMessage,
    claimPatternProblem,
} from "@eudiplo/config-format/claim-patterns.js";
import { z } from "zod";

// Claim field `constraints`: JSON Schema validation and annotation keywords
// only, recursively for subschemas, and patterns RE2 can run (CredentialConfig
// v3). The keyword lists, the pattern rules and the reasons live in
// @eudiplo/config-format.

const SubschemaSchema: z.ZodType<boolean | Record<string, unknown>> = z.lazy(
    () => z.union([z.boolean(), ClaimConstraintsSchema]),
);

export const ClaimConstraintsSchema: z.ZodType<Record<string, unknown>> = z
    .lazy(() =>
        z
            .strictObject(
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
            )
            .superRefine((schema, context) => {
                const patterns: [string, (string | number)[]][] = [];
                if (typeof schema.pattern === "string") {
                    patterns.push([schema.pattern, ["pattern"]]);
                }
                for (const name of Object.keys(
                    schema.patternProperties ?? {},
                )) {
                    patterns.push([name, ["patternProperties", name]]);
                }
                for (const [pattern, path] of patterns) {
                    const problem = claimPatternProblem(pattern);
                    if (problem) {
                        context.addIssue({
                            code: "custom",
                            path,
                            message: claimPatternMessage(pattern, problem),
                        });
                    }
                }
            }),
    )
    .meta({ id: "ClaimConstraints" });
