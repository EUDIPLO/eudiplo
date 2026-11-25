import { z } from "zod";
import {
    isStatusListCapacity,
    STATUS_LIST_CAPACITY_MESSAGE,
} from "../../../shared/domain/status-list-capacity.js";

export const StatusListImportSchema = z
    .object({
        id: z.string().min(1).describe("Status list identifier."),
        credentialConfigurationId: z
            .string()
            .min(1)
            .nullable()
            .optional()
            .describe(
                "Optional credential configuration binding. Null means shared list.",
            ),
        keyChainId: z
            .string()
            .min(1)
            .optional()
            .describe("Optional key chain used for signing this status list."),
        capacity: z.coerce
            .number()
            .int()
            .min(100)
            .optional()
            .describe("Optional list capacity override."),
        bits: z
            .union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)])
            .optional()
            .describe("Optional bits-per-status override."),
    })
    .describe("Payload for importing status lists from JSON config files.")
    .strict();

export const CreateStatusListSchema = z
    .object({
        credentialConfigurationId: z
            .string()
            .min(1)
            .optional()
            .describe("Optional credential configuration binding."),
        keyChainId: z
            .string()
            .min(1)
            .optional()
            .describe("Optional key chain to sign the list with."),
        bits: z
            .union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)])
            .optional()
            .describe("Optional bits-per-status value."),
        capacity: z.coerce
            .number()
            .int()
            .min(1000)
            .refine(isStatusListCapacity, STATUS_LIST_CAPACITY_MESSAGE)
            .optional()
            .describe("Optional status list capacity."),
    })
    .describe("Payload for creating a status list.")
    .strict();

export const UpdateStatusListConfigSchema = z
    .object({
        capacity: z.coerce
            .number()
            .int()
            .min(100)
            .refine(isStatusListCapacity, STATUS_LIST_CAPACITY_MESSAGE)
            .nullable()
            .optional()
            .describe(
                "Capacity override. Omit or set null to follow STATUS_CAPACITY.",
            ),
        bits: z
            .union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)])
            .nullable()
            .optional()
            .describe(
                "Bits-per-status override. Omit or set null to follow STATUS_BITS.",
            ),
        ttl: z.coerce
            .number()
            .int()
            .min(60)
            .nullable()
            .optional()
            .describe(
                "JWT TTL override in seconds. Omit or set null to follow STATUS_TTL.",
            ),
        immediateUpdate: z
            .boolean()
            .nullable()
            .optional()
            .describe(
                "Immediate regeneration toggle. Omit or set null to follow STATUS_IMMEDIATE_UPDATE.",
            ),
        enableAggregation: z
            .boolean()
            .nullable()
            .optional()
            .describe(
                "Aggregation URI toggle. Omit or set null to follow STATUS_ENABLE_AGGREGATION.",
            ),
    })
    .describe(
        "Payload replacing the tenant status list configuration; omitted fields follow the instance defaults.",
    )
    .strict();

export const UpdateStatusListSchema = z
    .object({
        credentialConfigurationId: z
            .string()
            .min(1)
            .nullable()
            .optional()
            .describe(
                "Updated credential configuration binding. Null means shared list.",
            ),
        keyChainId: z
            .string()
            .min(1)
            .nullable()
            .optional()
            .describe("Updated key chain id. Null means use tenant default."),
    })
    .describe("Payload for updating status list bindings.")
    .strict();
