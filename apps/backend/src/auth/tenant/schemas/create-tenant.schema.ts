import { z } from "zod";
import { allRoles } from "../../roles/role.enum.js";
import { SessionStorageConfigSchema } from "./session-storage-config.schema.js";
import { StatusListConfigSchema } from "./status-list-config.schema.js";

const RoleSchema = z.enum(
    allRoles as [(typeof allRoles)[number], ...(typeof allRoles)[number][]],
);

const NonBlankStringSchema = z.string().trim().min(1);

const DEFAULT_ACCESS_KEY_CHAIN_DESCRIPTION =
    "ID of the access key chain used where no configuration names one: presentation requests of configurations without accessKeyChainId and the signed issuer metadata. Without it, EUDIPLO picks one of the tenant's access key chains by rule.";

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
            .describe(
                "Roles of the tenant's admin client `<id>-admin`, which also gets clients:manage. They are all that client can grant, unless they include tenant:admin. Without roles, no admin client is created.",
            ),
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
})
    .extend({
        // Key chains are imported after the tenant, so only a file names one.
        defaultAccessKeyChainId: NonBlankStringSchema.optional().describe(
            DEFAULT_ACCESS_KEY_CHAIN_DESCRIPTION,
        ),
    })
    .describe("Payload used when importing tenant metadata from config files.");

const TenantConfigMetadataSchema = z
    .object({
        generation: z.number().int().min(1).optional(),
        ownership: z.enum(["unmanaged", "file-managed"]).optional(),
    })
    .strict();

export const TenantConfigFileSchema = z.union([
    z.strictObject({
        $schema: z.literal(
            "https://eudiplo.dev/schemas/v2/TenantConfigFile.schema.json",
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
        defaultAccessKeyChainId: NonBlankStringSchema.nullable()
            .optional()
            .describe(
                `${DEFAULT_ACCESS_KEY_CHAIN_DESCRIPTION} Omit to keep the current value or set to null to remove it.`,
            ),
    })
    .describe("Payload for partially updating tenant metadata.");

export type CreateTenant = z.infer<typeof CreateTenantSchema>;
export type UpdateTenant = z.infer<typeof UpdateTenantSchema>;
