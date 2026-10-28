import {
    defineEditorSchema,
    defineEditorSchemaBundle,
} from "../../../shared/common/zod/editor-schema.js";
import {
    CreateTenantSchema,
    ImportTenantSchema,
    TenantConfigFileSchema,
    UpdateTenantSchema,
} from "./create-tenant.schema.js";
import { KeyChainDefaultsConfigFileSchema } from "./key-chain-defaults.schema.js";
import { SessionStorageConfigSchema } from "./session-storage-config.schema.js";
import { StatusListConfigSchema } from "./status-list-config.schema.js";

export const tenantEditorSchemaBundle = defineEditorSchemaBundle({
    domain: "tenant",
    schemas: [
        defineEditorSchema({
            name: "CreateTenantDto",
            schema: CreateTenantSchema,
        }),
        defineEditorSchema({
            name: "TenantConfigFile",
            schema: TenantConfigFileSchema,
        }),
        defineEditorSchema({
            name: "ImportTenantDto",
            schema: ImportTenantSchema,
        }),
        defineEditorSchema({
            name: "UpdateTenantDto",
            schema: UpdateTenantSchema,
        }),
        defineEditorSchema({
            name: "KeyChainDefaultsConfigFile",
            schema: KeyChainDefaultsConfigFileSchema,
        }),
        defineEditorSchema({
            name: "SessionStorageConfig",
            schema: SessionStorageConfigSchema,
        }),
        defineEditorSchema({
            name: "StatusListConfig",
            schema: StatusListConfigSchema,
        }),
    ],
});
