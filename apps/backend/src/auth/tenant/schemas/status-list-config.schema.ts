import { z } from "zod";
import {
    isStatusListCapacity,
    STATUS_LIST_CAPACITY_MESSAGE,
} from "../../../shared/domain/status-list-capacity.js";

export const StatusListConfigSchema = z
    .strictObject({
        capacity: z.coerce
            .number()
            .int()
            .min(100)
            .refine(isStatusListCapacity, STATUS_LIST_CAPACITY_MESSAGE)
            .optional()
            .describe("Default status list capacity."),
        bits: z
            .union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)])
            .optional()
            .describe("Bits-per-status setting (1, 2, 4, or 8)."),
        ttl: z.coerce
            .number()
            .int()
            .min(60)
            .optional()
            .describe("JWT TTL for status list tokens in seconds."),
        immediateUpdate: z
            .boolean()
            .optional()
            .describe(
                "Regenerate status list JWTs immediately after status updates.",
            ),
        enableAggregation: z
            .boolean()
            .optional()
            .describe("Include aggregation_uri in generated status list JWTs."),
    })
    .describe(
        "Tenant defaults for status list generation and publishing behavior.",
    );
