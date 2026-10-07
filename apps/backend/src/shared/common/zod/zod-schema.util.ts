import { BadRequestException, type PipeTransform } from "@nestjs/common";
import {
    createZodValidationPipe,
    type ZodValidationException,
} from "nestjs-zod";
import { z } from "zod";

export interface ValidationIssue {
    path: Array<string | number>;
    message: string;
    code: string;
}

type ZodIssueLike = {
    path: ReadonlyArray<PropertyKey>;
    message: string;
    code: string;
};

const ENV_PLACEHOLDER_REGEX = /^\$\{([A-Z0-9_]+)\}$/;

function normalizeIssuePath(
    path: ReadonlyArray<PropertyKey>,
): Array<string | number> {
    return path.filter(
        (segment): segment is string | number =>
            typeof segment === "string" || typeof segment === "number",
    );
}

export function withMeta<T extends z.ZodTypeAny>(
    schema: T,
    metadata: Record<string, unknown>,
): T {
    return schema.meta(metadata);
}

function envPlaceholderSchema() {
    return z.string().regex(ENV_PLACEHOLDER_REGEX);
}

function nonEmptyStringSchema() {
    return z.string().trim().min(1);
}

function stringOrEnvPlaceholderSchema() {
    return z.union([nonEmptyStringSchema(), envPlaceholderSchema()]);
}

function optionalStringOrEnvPlaceholderSchema() {
    return stringOrEnvPlaceholderSchema().optional();
}

function urlSchema() {
    return z.string().trim().url();
}

function urlOrEnvPlaceholderSchema() {
    return z.union([urlSchema(), envPlaceholderSchema()]);
}

export function textField(description: string, example?: string) {
    return withMeta(stringOrEnvPlaceholderSchema(), {
        description,
        ...(example ? { examples: [example] } : {}),
    });
}

export function optionalTextField(description: string, example?: string) {
    return withMeta(optionalStringOrEnvPlaceholderSchema(), {
        description,
        ...(example ? { examples: [example] } : {}),
    });
}

export function urlField(description: string, example?: string) {
    return withMeta(urlOrEnvPlaceholderSchema(), {
        description,
        ...(example ? { examples: [example] } : {}),
    });
}

export function booleanField(description: string, example?: boolean) {
    return withMeta(z.boolean().optional(), {
        description,
        ...(example !== undefined ? { examples: [example] } : {}),
    });
}

export function toValidationIssues(
    issues: ReadonlyArray<ZodIssueLike>,
): ValidationIssue[] {
    return issues.map((issue) => ({
        path: normalizeIssuePath(issue.path),
        message: issue.message,
        code: issue.code,
    }));
}

function buildValidationBody(
    issues: ValidationIssue[],
    message = "Validation failed",
) {
    return {
        statusCode: 400,
        message,
        errors: issues,
        timestamp: new Date().toISOString(),
    };
}

export function createValidationException(
    issues: ValidationIssue[],
    message?: string,
) {
    return new BadRequestException(buildValidationBody(issues, message));
}

function zodErrorToValidationIssues(error: unknown): ValidationIssue[] {
    const zodError =
        (error as ZodValidationException | undefined)?.getZodError?.() ?? error;

    if (Array.isArray(zodError)) {
        return zodError.map((issue: any) => ({
            path: issue.path ?? [],
            message: issue.message ?? "Invalid value",
            code: issue.code ?? "custom",
        }));
    }

    const issues = (
        zodError as
            | {
                  issues?: Array<{
                      path: Array<string | number>;
                      message: string;
                      code: string;
                  }>;
              }
            | undefined
    )?.issues;
    if (!Array.isArray(issues)) {
        return [];
    }

    return issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
        code: issue.code,
    }));
}

interface ConfigBodyOptions {
    /** Fields that a GET response adds to the configuration; dropped. */
    readOnly: readonly string[];
    /** Partial update: every field optional, `null` clears an optional one. */
    partial?: boolean;
}

function accepts(schema: z.ZodType, value: unknown): boolean {
    try {
        return schema.safeParse(value).success;
    } catch {
        // Async refinements cannot run here; such a field counts as required.
        return false;
    }
}

/**
 * Validates the body of a configuration endpoint with the schema that
 * configuration import uses, so unknown or misspelled fields are rejected.
 * A GET response can still be sent back: the read-only fields it adds are
 * dropped, and `null` is accepted for optional fields (unset on create and
 * replace, cleared by a partial update). Use it where the body type is a
 * class DTO, which the app-wide pipe does not check. The body is passed on
 * as sent, not as parsed: parsing would fill in schema defaults, which a
 * partial update must not store.
 */
export function createConfigBodyPipe<Shape extends z.ZodRawShape>(
    schema: z.ZodObject<Shape>,
    { readOnly, partial = false }: ConfigBodyOptions,
): PipeTransform {
    const shape = schema.shape as unknown as Record<string, z.ZodType>;
    const optional = new Set(
        Object.entries(shape)
            .filter(([, field]) => accepts(field, undefined))
            .map(([key]) => key),
    );
    // Built from the shape because `.partial()` refuses objects with
    // refinements; refinements across fields are checked by the services
    // against the merged configuration.
    const partialSchema = z
        .object(
            Object.fromEntries(
                Object.entries(shape).map(([key, field]) => [
                    key,
                    optional.has(key)
                        ? field.nullable().optional()
                        : field.optional(),
                ]),
            ),
        )
        .strict();
    return {
        async transform(value: unknown) {
            let body = value;
            if (body && typeof body === "object" && !Array.isArray(body)) {
                body = Object.fromEntries(
                    Object.entries(body).filter(
                        ([key, fieldValue]) =>
                            !readOnly.includes(key) &&
                            // Without a merge, null and a missing field mean the same.
                            !(
                                !partial &&
                                fieldValue === null &&
                                optional.has(key) &&
                                !accepts(shape[key], null)
                            ),
                    ),
                );
            }
            const result = await (partial
                ? partialSchema
                : schema
            ).safeParseAsync(body);
            if (!result.success) {
                throw createValidationException(
                    zodErrorToValidationIssues(result.error),
                );
            }
            return body;
        },
    };
}

export function createAppValidationPipe() {
    const ZodValidationPipeClass = createZodValidationPipe({
        createValidationException: (error) =>
            createValidationException(zodErrorToValidationIssues(error)),
    });

    return new ZodValidationPipeClass();
}

export function findMissingEnvPlaceholderIssues(
    value: unknown,
    path: Array<string | number> = [],
): ValidationIssue[] {
    if (typeof value === "string") {
        const issues: ValidationIssue[] = [];
        for (const match of value.matchAll(/\$\{([A-Z0-9_]+)\}/g)) {
            const variableName = match[1];
            const variableValue = process.env[variableName];
            if (variableValue === undefined || variableValue === "") {
                issues.push({
                    path,
                    message: `Missing environment variable '${variableName}'`,
                    code: "missing_environment_variable",
                });
            }
        }
        return issues;
    }

    if (Array.isArray(value)) {
        return value.flatMap((item, index) =>
            findMissingEnvPlaceholderIssues(item, [...path, index]),
        );
    }

    if (value && typeof value === "object") {
        return Object.entries(value).flatMap(([key, item]) =>
            findMissingEnvPlaceholderIssues(item, [...path, key]),
        );
    }

    return [];
}

export function resolveEnvPlaceholders<T>(value: T): T {
    if (typeof value === "string") {
        return value.replace(
            /\$\{([A-Z0-9_]+)\}/g,
            (_, name: string) => process.env[name] ?? "",
        ) as unknown as T;
    }

    if (Array.isArray(value)) {
        return value.map((item) =>
            resolveEnvPlaceholders(item),
        ) as unknown as T;
    }

    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = resolveEnvPlaceholders(item);
        }
        return out as T;
    }

    return value;
}
