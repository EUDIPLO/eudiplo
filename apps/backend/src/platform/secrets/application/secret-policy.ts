import { TENANT_ID_PATTERN } from "@eudiplo/config-format/config-format.js";
import {
    parseSecretReference,
    type SecretReference,
} from "@eudiplo/config-format/config-values.js";
import { z } from "zod";
import { SecretPolicyError } from "../domain/secret-errors.js";
import type { SecretScope, SecretUse } from "../domain/secret-use.js";
import type { SecretSource, SecretSourceType } from "../ports/secret-source.js";

/** The key under `tenants` whose grants apply to every tenant. */
const EVERY_TENANT = "*";
const TENANT_TEMPLATE = "{tenant}";
/** `<Kind>:<path>`, the path with `*` for any array index or key. */
const FIELD_PATTERN = /^[A-Z][A-Za-z]*:[A-Za-z0-9_*]+(?:\.[A-Za-z0-9_*]+)*$/;

const boundGrantSchema = z
    .object({
        ref: z.string(),
        fields: z.array(z.string()).min(1),
        destinations: z.array(z.string()).min(1),
    })
    .strict();

/** Own namespaces per source type, and bound grants. */
const grantsSchema = z
    .object({ bound: z.array(boundGrantSchema).optional() })
    .catchall(z.array(z.string()));

/**
 * The operator's secret policy: which secret references the files and
 * resources of each tenant, and of the instance, may name.
 */
const secretPolicySchema = z
    .object({
        $schema: z.string().optional(),
        instance: grantsSchema.optional(),
        tenants: z.record(z.string(), grantsSchema).optional(),
    })
    .strict();

type RawGrants = z.infer<typeof grantsSchema>;

interface BoundGrant {
    reference: SecretReference;
    /** As written, and split at `:` and `.`. */
    fields: { text: string; parts: string[] }[];
    /** Origins, such as `https://csc.example.eu`. */
    destinations: Set<string>;
}

interface Grants {
    own: Map<SecretSourceType, string[]>;
    bound: BoundGrant[];
}

const NO_GRANTS: Grants = { own: new Map(), bound: [] };

/** Where grants were read from, for the checks across scopes. */
interface GrantScope {
    /** `instance`, `tenants.<id>` or `tenants.*`. */
    path: string;
    scopeType: SecretScope["type"];
    /** The tenant ID of `tenants.<id>`. */
    tenantId?: string;
    grants: Grants;
}

const describeScope = (scope: SecretScope) =>
    scope.type === "instance" ? "the instance" : `tenant '${scope.tenantId}'`;

function fieldMatches(pattern: string[], field: string): boolean {
    const parts = field.split(/[:.]/);
    return (
        parts.length === pattern.length &&
        pattern.every((part, index) => part === "*" || part === parts[index])
    );
}

function origin(url: string): string | undefined {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" || parsed.protocol === "http:"
            ? parsed.origin
            : undefined;
    } catch {
        return undefined;
    }
}

/** The text before `{tenant}`: the set holding every tenant's namespace. */
const templateRegion = (pattern: string) =>
    pattern.slice(0, pattern.indexOf(TENANT_TEMPLATE));

/**
 * Decides whether a use may name a secret reference. A scope may name:
 *
 * - a reference inside one of its own namespaces (`tenants.<id>.<source>`,
 *   or `tenants["*"]` with `{tenant}` for every tenant, `instance.<source>`
 *   for the operator's files). The value is the scope's own: it may be sent
 *   wherever the outbound URL policy allows.
 * - a reference of one of its bound grants, an operator secret the scope may
 *   only use in the listed fields and send to the listed origins.
 *
 * No grant lets a scope name what the source refuses for it, such as a
 * setting of EUDIPLO itself. {@link create} refuses a policy whose tenant
 * namespaces reach into another tenant's or the instance's, or that holds a
 * bound secret inside a tenant's own namespace, where it could be sent
 * anywhere.
 */
export class SecretPolicy {
    private constructor(
        private readonly sources: ReadonlyMap<SecretSourceType, SecretSource>,
        private readonly instance: Grants,
        private readonly tenants: ReadonlyMap<string, Grants>,
    ) {}

    /** A policy that lets nothing be named. */
    static empty(sources: readonly SecretSource[]): SecretPolicy {
        return new SecretPolicy(
            new Map(sources.map((source) => [source.type, source])),
            NO_GRANTS,
            new Map(),
        );
    }

    /**
     * @throws SecretPolicyError naming every problem of `input`. Messages
     * name paths and patterns, never a value written where a reference
     * belongs.
     */
    static create(
        input: unknown,
        sources: readonly SecretSource[],
    ): SecretPolicy {
        const bySource = new Map(
            sources.map((source) => [source.type, source]),
        );
        const parsed = secretPolicySchema.safeParse(input);
        if (!parsed.success) {
            throw new SecretPolicyError(
                parsed.error.issues.map(
                    (issue) =>
                        `${issue.path.join(".") || "(root)"}: ${issue.message}`,
                ),
            );
        }
        const issues: string[] = [];
        const scopes: GrantScope[] = [];
        if (parsed.data.instance)
            scopes.push({
                path: "instance",
                scopeType: "instance",
                grants: readGrants(
                    parsed.data.instance,
                    "instance",
                    "instance",
                    false,
                    bySource,
                    issues,
                ),
            });
        for (const [id, raw] of Object.entries(parsed.data.tenants ?? {})) {
            const path = `tenants.${id}`;
            scopes.push({
                path,
                scopeType: "tenant",
                tenantId: id === EVERY_TENANT ? undefined : id,
                grants: readGrants(
                    raw,
                    path,
                    "tenant",
                    id === EVERY_TENANT,
                    bySource,
                    issues,
                ),
            });
        }
        issues.push(...separationIssues(scopes, bySource));
        if (issues.length > 0) throw new SecretPolicyError(issues);
        const instance = scopes.find((scope) => scope.path === "instance");
        return new SecretPolicy(
            bySource,
            instance?.grants ?? NO_GRANTS,
            new Map(
                scopes
                    .filter((scope) => scope.scopeType === "tenant")
                    .map((scope) => [
                        scope.tenantId ?? EVERY_TENANT,
                        scope.grants,
                    ]),
            ),
        );
    }

    /** The source of `type`, when this instance has one. */
    source(type: SecretReference["source"]): SecretSource | undefined {
        return type === "required"
            ? undefined
            : this.sources.get(type as SecretSourceType);
    }

    /** Why `use` may not name `reference`, or undefined when it may. */
    refusal(reference: SecretReference, use: SecretUse): string | undefined {
        const { scope } = use;
        if (reference.source === "required")
            return "${required:…} marks a value that must be supplied and has none";
        const source = this.source(reference.source);
        if (!source)
            return `the source '${reference.source}' is not configured on this instance`;
        const refused = source.refusal(reference, scope.type);
        if (refused) return refused;
        const candidates = this.grantsOf(scope);
        if (inOwnNamespace(reference, source, candidates, scope.type))
            return undefined;
        return boundRefusal(reference, use, candidates);
    }

    /**
     * The grants that apply to `scope`, with the tenant ID `{tenant}`
     * stands for.
     */
    private grantsOf(scope: SecretScope): Candidates {
        if (scope.type === "instance") return [{ grants: this.instance }];
        if (scope.tenantId === EVERY_TENANT) return [];
        const own = {
            grants: this.tenants.get(scope.tenantId) ?? NO_GRANTS,
        };
        // {tenant} only stands for an ID that is one path segment of
        // letters, digits, _ and -: an ID from before 10.0 such as
        // `a/../b` gets none of these.
        if (!TENANT_ID_PATTERN.test(scope.tenantId)) return [own];
        return [
            own,
            {
                grants: this.tenants.get(EVERY_TENANT) ?? NO_GRANTS,
                tenant: scope.tenantId,
            },
        ];
    }
}

type Candidates = { grants: Grants; tenant?: string }[];

/** Whether `reference` lies inside an own namespace of the candidates. */
function inOwnNamespace(
    reference: SecretReference,
    source: SecretSource,
    candidates: Candidates,
    scopeType: SecretScope["type"],
): boolean {
    return candidates.some(({ grants, tenant }) =>
        (grants.own.get(source.type) ?? []).some((pattern) =>
            source.within(
                reference,
                tenant === undefined
                    ? pattern
                    : pattern.replaceAll(TENANT_TEMPLATE, tenant),
                scopeType,
            ),
        ),
    );
}

/** Why no bound grant of the candidates allows `use`, or undefined. */
function boundRefusal(
    reference: SecretReference,
    use: SecretUse,
    candidates: Candidates,
): string | undefined {
    const scope = describeScope(use.scope);
    const bound = candidates.flatMap(({ grants }) =>
        grants.bound.filter(
            (grant) => grant.reference.reference === reference.reference,
        ),
    );
    if (bound.length === 0) return `no grant of ${scope} covers it`;
    const inField = bound.filter((grant) =>
        grant.fields.some((field) => fieldMatches(field.parts, use.field)),
    );
    if (inField.length === 0) {
        const fields = bound
            .flatMap((grant) => grant.fields.map((field) => field.text))
            .join(", ");
        return `${scope} may use it only in ${fields}, not in ${use.field}`;
    }
    const target = use.destination ? origin(use.destination) : undefined;
    if (
        target !== undefined &&
        inField.some((grant) => grant.destinations.has(target))
    )
        return undefined;
    const allowed = [
        ...new Set(inField.flatMap((grant) => [...grant.destinations])),
    ].join(", ");
    const actual = use.destination
        ? `, not to ${target ?? "this address"}`
        : "";
    return `${scope} may send it only to ${allowed}${actual}`;
}

/** Reads and checks the grants of one scope. */
function readGrants(
    raw: RawGrants,
    path: string,
    scopeType: SecretScope["type"],
    everyTenant: boolean,
    sources: ReadonlyMap<SecretSourceType, SecretSource>,
    issues: string[],
): Grants {
    const own = new Map<SecretSourceType, string[]>();
    for (const [key, value] of Object.entries(raw)) {
        if (key === "bound") continue;
        const source = sources.get(key as SecretSourceType);
        if (!source) {
            issues.push(
                `${path}.${key}: unknown source; use one of ${[...sources.keys()].join(", ") || "(none)"} or bound`,
            );
            continue;
        }
        const patterns = (value as string[]).filter((pattern) => {
            const problem = ownPatternProblem(
                pattern,
                source,
                scopeType,
                everyTenant,
            );
            if (problem)
                issues.push(`${path}.${key}: '${pattern}': ${problem}`);
            return !problem;
        });
        own.set(source.type, patterns);
    }
    const bound = (raw.bound ?? []).flatMap((grant, index) => {
        const read = readBoundGrant(
            grant,
            `${path}.bound.${index}`,
            scopeType,
            sources,
        );
        issues.push(...read.issues);
        return read.grant ? [read.grant] : [];
    });
    return { own, bound };
}

function ownPatternProblem(
    pattern: string,
    source: SecretSource,
    scopeType: SecretScope["type"],
    everyTenant: boolean,
): string | undefined {
    const templated = pattern.includes(TENANT_TEMPLATE);
    if (templated && !(source.tenantTemplates && everyTenant)) {
        const which = source.tenantTemplates
            ? ""
            : ` of a source other than ${source.type}`;
        return `names ${TENANT_TEMPLATE}, which only grants in tenants["${EVERY_TENANT}"]${which} can`;
    }
    // Without a separator after it, the namespace of tenant `a` would hold
    // that of tenant `ab`.
    if (
        templated &&
        pattern
            .split(TENANT_TEMPLATE)
            .slice(1)
            .some((rest) => rest === "" || /^[a-z0-9_-]/.test(rest))
    )
        return `needs a separator after ${TENANT_TEMPLATE}, such as /, that no tenant ID contains`;
    if (everyTenant && !templated)
        return source.tenantTemplates
            ? `would give every tenant the same secrets; name ${TENANT_TEMPLATE} in it, or make it a bound grant`
            : `would give every tenant the same secrets, and ${source.type} has no ${TENANT_TEMPLATE} namespaces; grant it per tenant, or make it a bound grant`;
    return source.validatePattern(pattern, scopeType);
}

function readBoundGrant(
    grant: z.infer<typeof boundGrantSchema>,
    at: string,
    scopeType: SecretScope["type"],
    sources: ReadonlyMap<SecretSourceType, SecretSource>,
): { grant?: BoundGrant; issues: string[] } {
    const parsed = parseSecretReference(grant.ref);
    // The value is not repeated: it may be a secret written by mistake.
    if (!parsed) return { issues: [`${at}.ref: is no secret reference`] };
    if (!parsed.ok) return { issues: [`${at}.ref: ${parsed.message}`] };
    const reference = parsed.reference;
    const source =
        reference.source === "required"
            ? undefined
            : sources.get(reference.source);
    if (!source)
        return {
            issues: [
                `${at}.ref: the source '${reference.source}' cannot be granted`,
            ],
        };
    const refused = source.refusal(reference, scopeType);
    if (refused) return { issues: [`${at}.ref: ${refused}`] };
    const issues: string[] = [];
    const fields = grant.fields.filter((field) => {
        if (!FIELD_PATTERN.test(field)) {
            issues.push(
                `${at}.fields: '${field}' is no field; write <Kind>:<path>, for example KmsConfig:providers.*.clientSecret`,
            );
            return false;
        }
        if (field.split(/[:.]/).some((part) => /^\d+$/.test(part))) {
            issues.push(
                `${at}.fields: '${field}' names a position in a list, which changes when the list is reordered and which a tenant chooses; write * in its place`,
            );
            return false;
        }
        return true;
    });
    const destinations = new Set<string>();
    for (const destination of grant.destinations) {
        const found = origin(destination);
        if (found && found === destination.replace(/\/$/, ""))
            destinations.add(found);
        else
            issues.push(
                `${at}.destinations: '${destination}' is no origin; write scheme, host and port only, for example https://csc.example.eu`,
            );
    }
    return {
        grant: {
            reference,
            fields: fields.map((field) => ({
                text: field,
                parts: field.split(/[:.]/),
            })),
            destinations,
        },
        issues,
    };
}

/**
 * Refuses grants that would let one scope name another's secrets:
 *
 * - namespaces of two named tenants that overlap;
 * - a named tenant's namespace that reaches into the `{tenant}` namespaces
 *   of `tenants["*"]` beyond its own;
 * - a tenant namespace (named or `{tenant}`) that reaches into an instance
 *   namespace it does not lie inside of entirely;
 * - a bound secret inside any tenant's own namespace, where it could be
 *   sent anywhere instead of only to its destinations.
 */
function separationIssues(
    scopes: GrantScope[],
    sources: ReadonlyMap<SecretSourceType, SecretSource>,
): string[] {
    const named = scopes.filter((scope) => scope.tenantId !== undefined);
    const everyTenant = scopes.find(
        (scope) => scope.path === `tenants.${EVERY_TENANT}`,
    );
    const instance = scopes.find((scope) => scope.scopeType === "instance");
    return [...sources].flatMap(([type, source]) => {
        const own = (scope: GrantScope | undefined) =>
            scope?.grants.own.get(type) ?? [];
        const templates = own(everyTenant);
        const between = named.flatMap((scope, index) =>
            own(scope).flatMap((pattern) => [
                ...named
                    .slice(index + 1)
                    .flatMap((other) =>
                        tenantOverlaps(
                            source,
                            scope,
                            pattern,
                            other,
                            own(other),
                        ),
                    ),
                ...templates.flatMap((template) =>
                    templateReach(source, scope, pattern, template),
                ),
            ]),
        );
        // Every tenant namespace: as written, and for a template the set
        // that holds the namespaces of all tenants.
        const namespaces = [
            ...named.flatMap((scope) =>
                own(scope).map((pattern) => ({
                    label: `${scope.path}.${type} '${pattern}'`,
                    pattern,
                })),
            ),
            ...templates.map((template) => ({
                label: `tenants.${EVERY_TENANT}.${type} '${template}'`,
                pattern: templateRegion(template),
            })),
        ];
        const outward = namespaces.flatMap(({ label, pattern }) => [
            ...own(instance)
                .filter(
                    (instancePattern) =>
                        source.overlaps(pattern, instancePattern) &&
                        !source.contains(instancePattern, pattern),
                )
                .map(
                    (instancePattern) =>
                        `${label} reaches into instance.${type} '${instancePattern}', so a tenant could name secrets of the instance`,
                ),
            ...boundInside(source, scopes, label, pattern),
        ]);
        return [...between, ...outward];
    });
}

function tenantOverlaps(
    source: SecretSource,
    scope: GrantScope,
    pattern: string,
    other: GrantScope,
    otherPatterns: string[],
): string[] {
    return otherPatterns
        .filter((otherPattern) => source.overlaps(pattern, otherPattern))
        .map(
            (otherPattern) =>
                `${scope.path}.${source.type} '${pattern}' and ${other.path}.${source.type} '${otherPattern}' overlap, so each tenant could name the other's secrets`,
        );
}

/** A named tenant's pattern reaching beyond its own `{tenant}` namespace. */
function templateReach(
    source: SecretSource,
    scope: GrantScope,
    pattern: string,
    template: string,
): string[] {
    const tenantId = scope.tenantId ?? "";
    const mine = template.replaceAll(TENANT_TEMPLATE, tenantId);
    const insideOwn =
        TENANT_ID_PATTERN.test(tenantId) && source.contains(mine, pattern);
    if (!source.overlaps(pattern, templateRegion(template)) || insideOwn)
        return [];
    return [
        `${scope.path}.${source.type} '${pattern}' reaches into the namespaces of other tenants of tenants.${EVERY_TENANT}.${source.type} '${template}'`,
    ];
}

/** Bound secrets of any scope that lie inside a tenant namespace. */
function boundInside(
    source: SecretSource,
    scopes: GrantScope[],
    label: string,
    pattern: string,
): string[] {
    return scopes.flatMap((holder) =>
        holder.grants.bound
            .filter(
                (grant) =>
                    grant.reference.source === source.type &&
                    source.within(grant.reference, pattern, "tenant"),
            )
            .map(
                (grant) =>
                    `${holder.path}.bound: ${grant.reference.reference} lies inside ${label}, where it could be sent anywhere; keep bound secrets out of tenant namespaces`,
            ),
    );
}
