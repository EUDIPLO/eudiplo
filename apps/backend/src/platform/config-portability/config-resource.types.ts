import type {
    ConfigDocument,
    ConfigMigrationIssue,
    ConfigResourceKind,
} from "@eudiplo/config-format/config-format.js";

export type {
    ConfigDocument,
    ConfigFile,
    ConfigMigrationIssue,
    ConfigResourceKind,
} from "@eudiplo/config-format/config-format.js";
export { CONFIG_RESOURCE_KINDS } from "@eudiplo/config-format/config-format.js";
/**
 * `detached` marks a resource that was file-managed until an operator detached it.
 * Imports from its former source skip it until it is reattached.
 */
export type ConfigOwnership = "unmanaged" | "file-managed" | "detached";
export type ConfigImportMode = "disabled" | "create" | "upsert" | "replace";

export interface ConfigPlanOptions {
    /**
     * Apply the documents even when their resources are detached or carry an
     * older generation, and take file ownership again.
     */
    reattach?: boolean;
}

export interface ConfigMigrationResult<T = Record<string, unknown>> {
    document: ConfigDocument<T>;
    issues: ConfigMigrationIssue[];
    migrations: string[];
}

export type {
    ConfigBundle,
    ConfigBundleAsset,
    ConfigBundleRequirement,
} from "@eudiplo/config-format/config-bundle.js";

export interface ConfigImportPlanItem {
    kind: ConfigResourceKind;
    id: string;
    action: "create" | "update" | "unchanged" | "skip" | "delete" | "blocked";
    changes?: import("@eudiplo/config-format/config-values.js").ConfigChange[];
    metadataChanged?: boolean;
    sourceVersion: string;
    targetVersion: string;
    migrations: string[];
    issues: ConfigMigrationIssue[];
}

export interface ConfigImportPlan {
    tenantId: string;
    mode: ConfigImportMode;
    applicable: boolean;
    items: ConfigImportPlanItem[];
    issues: ConfigMigrationIssue[];
    planFingerprint?: string;
    operationId?: string;
    assets?: Array<{
        path: string;
        action: "create" | "update" | "unchanged" | "skip";
        currentHash?: string;
        currentContentType?: string;
        sha256: string;
    }>;
    generatedSecrets?: Array<{
        kind: "Client";
        id: string;
        path: "/spec/secret";
        value: string;
    }>;
}

/** Ordered recovery journal. A failed operation can have partial effects. */
export interface ConfigApplyOperation {
    stage:
        | "asset"
        | "resource"
        | "ownership"
        | "resource-and-ownership"
        | "delete"
        | "delete-ownership";
    kind?: ConfigResourceKind;
    id?: string;
    path?: string;
    status: "pending" | "running" | "completed" | "failed";
}
