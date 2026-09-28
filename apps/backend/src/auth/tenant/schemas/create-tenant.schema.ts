import { z } from "zod";
import { allRoles } from "../../roles/role.enum.js";
import { SessionStorageConfigSchema } from "./session-storage-config.schema.js";
import { StatusListConfigSchema } from "./status-list-config.schema.js";

const RoleSchema = z.enum(
    allRoles as [(typeof allRoles)[number], ...(typeof allRoles)[number][]],
);

const NonBlankStringSchema = z.string().trim().min(1);

export const CreateTenantSchema = z
    .strictObject({
        id: NonBlankStringSchema.describe("Unique tenant identifier."),
        name: NonBlankStringSchema.default("EUDIPLO").describe(
            "Display name of the tenant.",
        ),
        description: NonBlankStringSchema.optional().describe(
            "Optional tenant description.",
        ),
        roles: z
            .array(RoleSchema)
            .optional()
            .describe("Optional default role assignments for the tenant."),
        sessionConfig: SessionStorageConfigSchema.optional().describe(
            "Optional tenant-specific session storage configuration.",
        ),
        statusListConfig: StatusListConfigSchema.optional().describe(
            "Optional tenant-specific status list defaults.",
        ),
    })
    .describe("Payload for creating a tenant.");

export const ImportTenantSchema = CreateTenantSchema.pick({
    name: true,
    description: true,
    sessionConfig: true,
    statusListConfig: true,
}).describe("Payload used when importing tenant metadata from config files.");

const TenantConfigMetadataSchema = z
    .object({
        generation: z.number().int().min(1).optional(),
        ownership: z.enum(["unmanaged", "file-managed"]).optional(),
    })
    .strict();

export const TenantConfigFileSchema = z.union([
    z.strictObject({
        $schema: z.literal(
            "https://eudiplo.dev/schemas/v1/TenantConfigFile.schema.json",
        ),
        metadata: TenantConfigMetadataSchema,
        spec: ImportTenantSchema,
    }),
    ImportTenantSchema,
]);

export const UpdateTenantSchema = z
    .strictObject({
        name: NonBlankStringSchema.optional().describe(
            "Display name of the tenant.",
        ),
        description: NonBlankStringSchema.nullable()
            .optional()
            .describe(
                "Tenant description. Omit to keep the current value or set to null to remove it.",
            ),
        sessionConfig: SessionStorageConfigSchema.optional().describe(
            "Optional tenant-specific session storage configuration.",
        ),
        statusListConfig: StatusListConfigSchema.optional().describe(
            "Optional tenant-specific status list defaults.",
        ),
    })
    .describe("Payload for partially updating tenant metadata.");

export type CreateTenant = z.infer<typeof CreateTenantSchema>;
export type UpdateTenant = z.infer<typeof UpdateTenantSchema>;
