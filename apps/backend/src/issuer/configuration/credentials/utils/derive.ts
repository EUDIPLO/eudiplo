import type {
    ClaimDisplayInfo,
    ClaimFieldDefinition,
    ClaimMetadata,
    JsonSchema,
} from "./types.js";

const JSON_SCHEMA_DRAFT_2020_12 =
    "https://json-schema.org/draft/2020-12/schema";

type Segment = string | number | null;
type PathCursor = Record<string, unknown> | unknown[];

function resolveChildPath(
    parentPath: Segment[],
    parentType: ClaimFieldDefinition["type"],
    childPath: Segment[],
): Segment[] {
    if (childPath.length >= parentPath.length) {
        const startsWithParent = parentPath.every(
            (seg, i) => seg === childPath[i],
        );
        if (startsWithParent) {
            return childPath;
        }
    }
    // Children of an array field describe its items, as in the SDK: insert the
    // item step unless the relative path already starts with one
    if (parentType === "array" && typeof childPath[0] === "string") {
        return [...parentPath, null, ...childPath];
    }
    return [...parentPath, ...childPath];
}

function flattenFields(fields: ClaimFieldDefinition[]): ClaimFieldDefinition[] {
    const result: ClaimFieldDefinition[] = [];

    for (const field of fields) {
        const { children, ...fieldWithoutChildren } = field;
        result.push(fieldWithoutChildren);

        if (children && children.length > 0) {
            const resolvedChildren: ClaimFieldDefinition[] = children.map(
                (child) => ({
                    ...child,
                    path: resolveChildPath(field.path, field.type, child.path),
                }),
            );
            result.push(...flattenFields(resolvedChildren));
        }
    }

    return result;
}

function getFieldNamespace(field: ClaimFieldDefinition): string | undefined {
    if (field.namespace) {
        return field.namespace;
    }

    const firstPathSegment = field.path.at(0);
    return typeof firstPathSegment === "string" && field.path.length > 1
        ? firstPathSegment
        : undefined;
}

function segmentToKey(segment: Segment): string {
    if (segment === null) {
        return "*";
    }
    return String(segment);
}

function getOrCreateChild(
    target: Record<string, unknown>,
    key: string,
    nextIsArray: boolean,
): PathCursor {
    const current = target[key];
    if (current !== undefined) {
        if (Array.isArray(current)) {
            return current;
        }
        if (typeof current === "object" && current !== null) {
            return current as Record<string, unknown>;
        }
    }

    const created: PathCursor = nextIsArray ? [] : {};
    target[key] = created;
    return created;
}

function getArrayIndex(segment: Segment): number | undefined {
    const arrayIndex =
        typeof segment === "number" ? segment : Number(segmentToKey(segment));
    return Number.isFinite(arrayIndex) && arrayIndex >= 0
        ? arrayIndex
        : undefined;
}

function setArrayPathValue(
    cursor: unknown[],
    segment: Segment,
    isLast: boolean,
    next: Segment,
    value: unknown,
): PathCursor | undefined {
    const arrayIndex = getArrayIndex(segment);
    if (arrayIndex === undefined) {
        return undefined;
    }

    if (isLast) {
        cursor[arrayIndex] = value;
        return undefined;
    }

    const current = cursor[arrayIndex];
    if (typeof current !== "object" || current === null) {
        cursor[arrayIndex] = typeof next === "number" ? [] : {};
    }

    return cursor[arrayIndex] as Record<string, unknown> | unknown[];
}

function setObjectPathValue(
    cursor: Record<string, unknown>,
    segment: Segment,
    isLast: boolean,
    next: Segment,
    value: unknown,
): PathCursor | undefined {
    const key = segmentToKey(segment);

    if (isLast) {
        cursor[key] = value;
        return undefined;
    }

    return getOrCreateChild(cursor, key, typeof next === "number");
}

function setValueAtPath(
    target: Record<string, unknown>,
    path: Segment[],
    value: unknown,
): void {
    if (path.length === 0) {
        return;
    }

    let cursor: PathCursor = target;

    for (let index = 0; index < path.length; index += 1) {
        const segment = path[index];
        const isLast = index === path.length - 1;
        const next = path[index + 1];
        const nextCursor: PathCursor | undefined = Array.isArray(cursor)
            ? setArrayPathValue(cursor, segment, isLast, next, value)
            : setObjectPathValue(cursor, segment, isLast, next, value);

        if (!nextCursor) {
            return;
        }

        cursor = nextCursor;
    }
}

function getDisplayTitle(
    display: ClaimFieldDefinition["display"],
): string | undefined {
    if (!display || display.length === 0) {
        return undefined;
    }

    const en = display.find((entry) =>
        entry.locale.toLowerCase().startsWith("en"),
    );
    return en?.name ?? display[0]?.name;
}

function mergeLeafSchema(existing: JsonSchema, next: JsonSchema): JsonSchema {
    const merged: JsonSchema = { ...next };
    if (existing.properties && Object.keys(existing.properties).length > 0) {
        merged.properties = existing.properties;
    }
    // An explicit `additionalProperties` from the field's constraints wins over the strict default
    if (
        !Object.hasOwn(next, "additionalProperties") &&
        Object.hasOwn(existing, "additionalProperties")
    ) {
        merged.additionalProperties = existing.additionalProperties;
    }
    if (Array.isArray(existing.required) && existing.required.length > 0) {
        merged.required = existing.required;
    }
    stripNonObjectKeywords(merged);
    return merged;
}

function stripNonObjectKeywords(schema: JsonSchema): void {
    const type = typeof schema.type === "string" ? schema.type : undefined;
    if (!type || type === "object") {
        return;
    }

    delete schema.properties;
    delete schema.additionalProperties;
    delete schema.required;
}

function buildLeafSchema(field: ClaimFieldDefinition): JsonSchema {
    const leafSchema: JsonSchema = {
        ...field.constraints,
        type: field.type,
    };

    const title = getDisplayTitle(field.display);
    if (title) {
        leafSchema.title = title;
    }

    return leafSchema;
}

function addRequired(parent: JsonSchema, key: string): void {
    if (!Array.isArray(parent.required)) {
        parent.required = [];
    }
    if (!parent.required.includes(key)) {
        parent.required.push(key);
    }
}

function isArrayPathSegment(segment: string | number | null): boolean {
    return typeof segment === "number" || segment === null;
}

function ensureSchemaNode(
    root: JsonSchema,
    path: Array<string | number | null>,
): JsonSchema {
    let cursor = root;

    for (const segment of path) {
        if (isArrayPathSegment(segment)) {
            if (cursor.type !== "array") {
                cursor.type = "array";
                delete cursor.properties;
                delete cursor.additionalProperties;
                delete cursor.required;
            }

            if (
                !cursor.items ||
                typeof cursor.items !== "object" ||
                Array.isArray(cursor.items)
            ) {
                cursor.items = {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                };
            }

            cursor = markObjectStrict(cursor.items as JsonSchema);
            continue;
        }

        const key = segmentToKey(segment);
        cursor.properties ??= {};

        if (!cursor.properties[key]) {
            cursor.properties[key] = {
                type: "object",
                properties: {},
                additionalProperties: false,
            };
        }

        cursor = markObjectStrict(cursor.properties[key]);
    }

    return cursor;
}

// Objects with declared child claims reject unknown properties unless the field opted into free-form
function markObjectStrict(node: JsonSchema): JsonSchema {
    if (
        node.type === "object" &&
        !Object.hasOwn(node, "additionalProperties")
    ) {
        node.additionalProperties = false;
    }
    return node;
}

function ensureFrameNode(
    root: Record<string, unknown>,
    path: Segment[],
): Record<string, unknown> {
    let cursor = root;

    for (const segment of path) {
        const key = segmentToKey(segment);
        const current = cursor[key];
        if (!current || typeof current !== "object" || Array.isArray(current)) {
            cursor[key] = {};
        }

        cursor = cursor[key] as Record<string, unknown>;
    }

    return cursor;
}

function applyLeafSchema(root: JsonSchema, field: ClaimFieldDefinition): void {
    const parent = ensureSchemaNode(root, field.path.slice(0, -1));
    const leafSegment = field.path.at(-1);
    const leafSchema = buildLeafSchema(field);

    if (isArrayPathSegment(leafSegment ?? null)) {
        mergeArrayLeafSchema(parent, leafSchema);
        return;
    }

    mergeObjectLeafSchema(parent, leafSegment, leafSchema, field.mandatory);
}

function mergeArrayLeafSchema(
    parent: JsonSchema,
    leafSchema: JsonSchema,
): void {
    if (parent.type !== "array") {
        parent.type = "array";
    }

    delete parent.properties;
    delete parent.additionalProperties;
    delete parent.required;

    const existingItems =
        parent.items &&
        typeof parent.items === "object" &&
        !Array.isArray(parent.items)
            ? (parent.items as JsonSchema)
            : undefined;

    parent.items = existingItems
        ? mergeLeafSchema(existingItems, leafSchema)
        : leafSchema;
}

function mergeObjectLeafSchema(
    parent: JsonSchema,
    leafSegment: string | number | null | undefined,
    leafSchema: JsonSchema,
    mandatory: boolean | undefined,
): void {
    const leafKey = segmentToKey(leafSegment ?? "");
    parent.properties ??= {};

    const existing = parent.properties[leafKey];
    parent.properties[leafKey] =
        existing && typeof existing === "object" && !Array.isArray(existing)
            ? mergeLeafSchema(existing, leafSchema)
            : leafSchema;

    if (mandatory) {
        addRequired(parent, leafKey);
    }
}

function normalizeDisplayInfo(
    display: ClaimFieldDefinition["display"],
): ClaimDisplayInfo[] | undefined {
    if (!display || display.length === 0) {
        return undefined;
    }

    return display;
}

export function buildClaims(
    fields: ClaimFieldDefinition[],
): Record<string, unknown> {
    const claims: Record<string, unknown> = {};

    for (const field of flattenFields(fields)) {
        if (!Object.prototype.hasOwnProperty.call(field, "defaultValue")) {
            continue;
        }

        setValueAtPath(claims, field.path, field.defaultValue);
    }

    return claims;
}

export function buildDisclosureFrame(
    fields: ClaimFieldDefinition[],
): Record<string, unknown> | undefined {
    const frame: Record<string, unknown> = {};
    let hasDisclosure = false;

    for (const field of flattenFields(fields)) {
        if (!field.disclosable || field.path.length === 0) {
            continue;
        }

        const parentPath = field.path.slice(0, -1);
        const leaf = segmentToKey(field.path.at(-1) ?? "");

        const node = ensureFrameNode(frame, parentPath);
        const existing = Array.isArray(node._sd) ? node._sd : [];
        if (!existing.includes(leaf)) {
            existing.push(leaf);
            node._sd = existing;
        }

        hasDisclosure = true;
    }

    return hasDisclosure ? frame : undefined;
}

export function buildClaimsMetadata(
    fields: ClaimFieldDefinition[],
): ClaimMetadata[] {
    return flattenFields(fields)
        .filter((field) => field.path.length > 0)
        .map((field) => {
            const metadata: ClaimMetadata = {
                path: field.path.map((segment) => segmentToKey(segment)),
            };
            if (field.namespace) {
                metadata.path = [field.namespace, ...metadata.path];
            }

            if (typeof field.mandatory === "boolean") {
                metadata.mandatory = field.mandatory;
            }

            const display = normalizeDisplayInfo(field.display);
            if (display) {
                metadata.display = display;
            }

            return metadata;
        });
}

export function buildJsonSchema(fields: ClaimFieldDefinition[]): JsonSchema {
    const root: JsonSchema = {
        $schema: JSON_SCHEMA_DRAFT_2020_12,
        type: "object",
        properties: {},
        additionalProperties: false,
    };

    for (const field of flattenFields(fields)) {
        if (field.path.length === 0) {
            continue;
        }

        applyLeafSchema(root, field);
    }

    return root;
}

export function buildClaimsByNamespace(
    fields: ClaimFieldDefinition[],
): Record<string, Record<string, unknown>> {
    const byNamespace: Record<string, Record<string, unknown>> = {};

    for (const field of flattenFields(fields)) {
        const namespace = getFieldNamespace(field);
        if (
            !namespace ||
            !Object.prototype.hasOwnProperty.call(field, "defaultValue")
        ) {
            continue;
        }

        if (!byNamespace[namespace]) {
            byNamespace[namespace] = {};
        }

        const namespaceTarget = byNamespace[namespace];
        const normalizedPath =
            field.path.length > 0 &&
            segmentToKey(field.path[0] ?? "") === namespace
                ? field.path.slice(1)
                : field.path;

        if (normalizedPath.length === 0) {
            continue;
        }

        setValueAtPath(namespaceTarget, normalizedPath, field.defaultValue);
    }

    return byNamespace;
}
