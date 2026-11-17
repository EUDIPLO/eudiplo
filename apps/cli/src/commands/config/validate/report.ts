import type { TenantValidationResult, ValidationIssue } from "./types.js";

export function buildJsonReport(results: TenantValidationResult[]) {
    return {
        valid: results.every((result) => result.valid),
        tenants: results.map((result) => ({
            id: result.id,
            valid: result.valid,
            files: result.files,
            errors: result.errors.map((error) => ({
                file: error.file,
                path: error.path,
                message: error.message,
            })),
            warnings: result.warnings.map((warning) => ({
                file: warning.file,
                message: warning.message,
            })),
        })),
        summary: {
            tenants: results.length,
            files: results.reduce((sum, result) => sum + result.files, 0),
            errors: results.reduce(
                (sum, result) => sum + result.errors.length,
                0,
            ),
        },
    };
}

export function formatTextReport(
    scope: "tenant" | "tenants",
    rootPath: string,
    results: TenantValidationResult[],
): string {
    const header: string =
        scope === "tenants"
            ? `Validating tenant configuration root: ${rootPath}`
            : `Validating tenant configuration: ${rootPath}`;

    const lines = [
        header,
        "",
        ...results.flatMap(formatTenantBlock),
        formatSummaryLine(results),
    ];

    return `${lines.join("\n")}\n`;
}

function formatTenantBlock(result: TenantValidationResult): string[] {
    const lines = [`${result.valid ? "PASS" : "FAIL"} ${result.id}`];

    if (result.valid) {
        for (const [resourceType, count] of Object.entries(
            result.resourceCounts,
        )) {
            lines.push(`  ${count} ${pluralize(resourceType, count)}`);
        }
    } else {
        lines.push(...formatTenantErrors(result.errors));
    }
    for (const warning of result.warnings) {
        lines.push(`  warning ${warning.file}: ${warning.message}`);
    }

    lines.push("");
    return lines;
}

function formatTenantErrors(errors: ValidationIssue[]): string[] {
    const lines: string[] = [];
    for (const [file, issues] of groupErrorsByFile(errors)) {
        lines.push(`  ${file}`);
        for (const issue of issues) {
            lines.push(`    ${formatIssueMessage(issue)}`);
        }
    }
    return lines;
}

function formatIssueMessage(issue: ValidationIssue): string {
    return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

function formatSummaryLine(results: TenantValidationResult[]): string {
    const totalFiles = results.reduce((sum, result) => sum + result.files, 0);
    const totalErrors = results.reduce(
        (sum, result) => sum + result.errors.length,
        0,
    );

    if (totalErrors === 0) {
        return `Validated ${results.length} tenant(s) and ${totalFiles} configuration file(s).\nNo errors found.`;
    }

    const failedTenants = results.filter((result) => !result.valid).length;
    return `Validation failed: ${totalErrors} error(s) in ${failedTenants} tenant(s).`;
}

function groupErrorsByFile(
    errors: ValidationIssue[],
): Array<[string, ValidationIssue[]]> {
    const grouped = new Map<string, ValidationIssue[]>();
    for (const error of errors) {
        const existing = grouped.get(error.file);
        if (existing) {
            existing.push(error);
            continue;
        }
        grouped.set(error.file, [error]);
    }
    return Array.from(grouped.entries());
}

function pluralize(label: string, count: number): string {
    return count === 1 ? label : `${label}s`;
}
