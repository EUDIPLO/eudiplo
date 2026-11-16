export type FixedFileResourceDefinition = {
    kind: "file";
    file: string;
    resourceType: string;
    schemaFile: string;
    required: boolean;
    /** Editor (`.vscode/settings.json`) `json.schemas` fileMatch globs generated for this entry. */
    fileMatch: string[];
    /** False for editor-only schemas that are not scanned by the CLI validator. */
    cliValidated?: boolean;
};

export type DirectoryResourceDefinition = {
    kind: "directory";
    subfolder: string;
    resourceType: string;
    schemaFile: string;
    fileMatch: string[];
    cliValidated?: boolean;
};

export type TenantResourceDefinition =
    | FixedFileResourceDefinition
    | DirectoryResourceDefinition;

export interface ValidationIssue {
    file: string;
    path?: string;
    message: string;
}

export interface TenantValidationResult {
    id: string;
    valid: boolean;
    files: number;
    errors: ValidationIssue[];
    /** Placeholders without a value, when validated with allowUnresolvedPlaceholders. */
    unresolved?: ValidationIssue[];
    resourceCounts: Record<string, number>;
}
