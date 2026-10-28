import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { ClaimConstraintsSchema } from "../schemas/claim-constraints.schema.js";

const FieldDisplaySchema = z
    .object({
        locale: z.string(),
        name: z.string(),
        description: z.string().optional(),
    })
    .strict();

const ClaimFieldDefinitionSchema: z.ZodType<any> = z.lazy(() =>
    z
        .object({
            path: z.array(z.union([z.string(), z.number(), z.null()])),
            type: z.enum([
                "string",
                "number",
                "integer",
                "boolean",
                "object",
                "array",
            ]),
            defaultValue: z.unknown().optional(),
            mandatory: z.boolean().optional(),
            disclosable: z.boolean().optional(),
            namespace: z.string().optional(),
            display: z.array(FieldDisplaySchema).optional(),
            constraints: ClaimConstraintsSchema.optional(),
            children: z.array(ClaimFieldDefinitionSchema).optional(),
        })
        .strict(),
);

export class FieldDisplayDto extends createZodDto(FieldDisplaySchema) {
    locale!: string;

    @ApiProperty({ description: "Display name", example: "Given Name" })
    name!: string;

    @ApiPropertyOptional({
        description: "Optional display description",
        example: "Primary first name",
    })
    description?: string;
}

export class ClaimFieldDefinitionDto extends createZodDto(
    ClaimFieldDefinitionSchema,
) {
    @ApiProperty({
        description:
            "Path to claim value. For nested child fields this can be relative to the parent path.",
        example: ["address", "locality"],
        type: "array",
        items: {
            oneOf: [{ type: "string" }, { type: "number" }, { type: "null" }],
        },
    })
    path!: Array<string | number | null>;

    @ApiProperty({
        description: "Claim value type",
        enum: ["string", "number", "integer", "boolean", "object", "array"],
    })
    type!: "string" | "number" | "integer" | "boolean" | "object" | "array";

    @ApiPropertyOptional({
        description: "Default value",
        oneOf: [
            { type: "string" },
            { type: "number" },
            { type: "boolean" },
            { type: "object", additionalProperties: true },
            { type: "array", items: {} },
            { type: "null" },
        ],
    })
    defaultValue?: unknown;

    @ApiPropertyOptional({ description: "Whether claim is mandatory" })
    mandatory?: boolean;

    @ApiPropertyOptional({
        description: "Whether claim is disclosable in SD-JWT",
    })
    disclosable?: boolean;

    @ApiPropertyOptional({
        description:
            "Namespace for mDOC field. Optional when the namespace is already present as the first path segment.",
        example: "eu.europa.ec.eudi.pid.1",
    })
    namespace?: string;

    @ApiPropertyOptional({ type: () => [FieldDisplayDto] })
    display?: FieldDisplayDto[];

    @ApiPropertyOptional({
        description:
            "JSON Schema 2020-12 validation keywords for this field. Only the JSON Schema keywords listed under Constraints in the claims documentation are accepted (validation keywords such as pattern, minLength or enum, subschemas such as items or properties, and annotations); other keys, such as format or $ref, are refused.",
        type: Object,
    })
    constraints?: Record<string, unknown>;

    @ApiPropertyOptional({
        description:
            "Optional nested child fields. Child paths may be specified relative to the parent field path.",
        type: () => [ClaimFieldDefinitionDto],
    })
    children?: ClaimFieldDefinitionDto[];
}
