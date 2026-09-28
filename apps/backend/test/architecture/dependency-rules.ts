import { relative, resolve } from "node:path";
import ts from "typescript";

type Role =
    | "application"
    | "domain"
    | "port"
    | "adapter"
    | "controller"
    | "composition"
    | "legacy";
export interface Dependency {
    specifier: string;
    target?: string;
    names: string[];
    reexport?: boolean;
}

/** Source dependencies, including erased types and barrel exports. */
function dependencies(source: ts.SourceFile): Dependency[] {
    const result: Dependency[] = [];
    const forwardedNames = new Set<string>();
    for (const statement of source.statements) {
        if (
            ts.isExportDeclaration(statement) &&
            !statement.moduleSpecifier &&
            statement.exportClause &&
            ts.isNamedExports(statement.exportClause)
        ) {
            for (const item of statement.exportClause.elements)
                forwardedNames.add((item.propertyName ?? item.name).text);
        }
        if (
            ts.isExportAssignment(statement) &&
            ts.isIdentifier(statement.expression)
        )
            forwardedNames.add(statement.expression.text);
    }
    const add = (
        expression: ts.Node | undefined,
        names: string[] = [],
        reexport = false,
    ) => {
        result.push({
            specifier:
                expression && ts.isStringLiteralLike(expression)
                    ? expression.text
                    : "<computed import>",
            names,
            reexport,
        });
    };
    const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node)) {
            const bindings = node.importClause?.namedBindings;
            const localNames = [
                ...(node.importClause?.name
                    ? [node.importClause.name.text]
                    : []),
                ...(bindings && ts.isNamedImports(bindings)
                    ? bindings.elements.map((item) => item.name.text)
                    : bindings
                      ? [bindings.name.text]
                      : []),
            ];
            add(
                node.moduleSpecifier,
                bindings && ts.isNamedImports(bindings)
                    ? bindings.elements.map(
                          (item) => (item.propertyName ?? item.name).text,
                      )
                    : ["*"],
                localNames.some((name) => forwardedNames.has(name)),
            );
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
            add(
                node.moduleSpecifier,
                node.exportClause && ts.isNamedExports(node.exportClause)
                    ? node.exportClause.elements.map(
                          (item) => (item.propertyName ?? item.name).text,
                      )
                    : ["*"],
                true,
            );
        } else if (
            ts.isImportTypeNode(node) &&
            ts.isLiteralTypeNode(node.argument)
        ) {
            add(node.argument.literal, ["*"]);
        } else if (
            ts.isImportEqualsDeclaration(node) &&
            ts.isExternalModuleReference(node.moduleReference)
        ) {
            add(node.moduleReference.expression, ["*"]);
        } else if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) &&
                    node.expression.text === "require"))
        ) {
            add(node.arguments[0], ["*"]);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return result;
}

function roleOf(file: string): Role {
    if (/(^|\/)application\//.test(file)) return "application";
    if (/(^|\/)domain\//.test(file)) return "domain";
    if (/(^|\/)ports\//.test(file)) return "port";
    if (/(^|\/)(adapters|infrastructure|entities)\//.test(file))
        return "adapter";
    if (file.endsWith(".controller.ts")) return "controller";
    if (file.endsWith(".module.ts")) return "composition";
    return "legacy";
}

export function readGraph(
    files: string[],
    options: ts.CompilerOptions,
    host: ts.ModuleResolutionHost = ts.sys,
): Map<string, Dependency[]> {
    return new Map(
        files.map((file) => {
            const source = ts.createSourceFile(
                file,
                host.readFile(file) ?? "",
                ts.ScriptTarget.Latest,
                true,
            );
            return [
                file,
                dependencies(source).map((dependency) => ({
                    ...dependency,
                    target: ts.resolveModuleName(
                        dependency.specifier,
                        file,
                        options,
                        host,
                    ).resolvedModule?.resolvedFileName,
                })),
            ];
        }),
    );
}

const forbiddenPackages =
    /^(typeorm|@nestjs\/(typeorm|axios|config|schedule|event-emitter|swagger)|express|axios|undici|node-vault|nestjs-otel|@opentelemetry\/[^/]+|@aws-sdk\/[^/]+|@azure\/[^/]+|@keycloak\/keycloak-admin-client|class-validator|class-transformer|nestjs-zod|nestjs-pino|(?:node:)?(?:fs|http|https))(\/|$)/;
const coreRoles: Role[] = ["application", "domain", "port"];

/** Check the transitive closure so an unclassified helper/barrel cannot hide an adapter. */
export function boundaryViolations(
    graph: Map<string, Dependency[]>,
    root: string,
): string[] {
    const violations = new Set<string>();
    const localName = (file: string) =>
        relative(root, file).replaceAll("\\", "/");
    for (const origin of graph.keys()) {
        const role = roleOf(localName(origin));
        if (!coreRoles.includes(role)) continue;
        const seen = new Set<string>();
        const walk = (file: string, trail: string[]) => {
            if (seen.has(file)) return;
            seen.add(file);
            for (const dependency of graph.get(file) ?? []) {
                const chain = [...trail, dependency.specifier];
                let reason: string | undefined;
                if (forbiddenPackages.test(dependency.specifier))
                    reason = "infrastructure dependency";
                if (
                    dependency.specifier === "@nestjs/common" &&
                    (role !== "application" ||
                        dependency.names.some(
                            (name) =>
                                !["Inject", "Injectable", "Optional"].includes(
                                    name,
                                ),
                        ))
                ) {
                    reason = "framework behavior outside composition/transport";
                }
                if (
                    dependency.specifier.startsWith("@nestjs/") &&
                    (role !== "application" ||
                        dependency.specifier !== "@nestjs/common")
                )
                    reason =
                        "framework dependency outside composition/transport";
                if (dependency.specifier === "<computed import>")
                    reason = "unverifiable computed import";
                if (dependency.target && graph.has(dependency.target)) {
                    const targetRole = roleOf(localName(dependency.target));
                    if (
                        ["adapter", "controller", "composition"].includes(
                            targetRole,
                        ) ||
                        (role === "domain" &&
                            ["application", "port"].includes(targetRole)) ||
                        (role === "port" && targetRole === "application")
                    )
                        reason = `forbidden ${role} -> ${targetRole} dependency`;
                    if (!reason) walk(dependency.target, chain);
                } else if (
                    dependency.specifier.startsWith(".") ||
                    dependency.specifier.startsWith("#") ||
                    dependency.target?.startsWith(`${resolve(root)}/`)
                ) {
                    reason = "unresolved local dependency";
                }
                if (reason)
                    violations.add(
                        `${localName(origin)}: ${chain.join(" -> ")} (${reason})`,
                    );
            }
        };
        walk(origin, []);
    }
    return [...violations].sort();
}

/** Controllers may use application services, but may not bypass them through persistence. */
export function controllerPersistenceViolations(
    graph: Map<string, Dependency[]>,
    root: string,
): string[] {
    const result = new Set<string>();
    const name = (file: string) => relative(root, file).replaceAll("\\", "/");
    for (const origin of graph.keys()) {
        if (roleOf(name(origin)) !== "controller") continue;
        const seen = new Set<string>();
        const walk = (file: string, exportsOnly = false) => {
            if (seen.has(file)) return;
            seen.add(file);
            for (const dep of graph.get(file) ?? []) {
                if (exportsOnly && !dep.reexport) continue;
                if (
                    /^(typeorm|@nestjs\/typeorm)(\/|$)/.test(dep.specifier) ||
                    (dep.target &&
                        /\/(adapters|infrastructure|ports)\/.*repository[^/]*\.ts$/.test(
                            dep.target,
                        ))
                ) {
                    result.add(
                        `${name(origin)} -> ${dep.target ? name(dep.target) : dep.specifier}`,
                    );
                }
                // Follow re-export barrels, not application service implementations.
                if (
                    dep.target &&
                    graph.get(dep.target)?.some((exported) => exported.reexport)
                ) {
                    walk(dep.target, true);
                }
            }
        };
        walk(origin);
    }
    return [...result].sort();
}

/** First path segment under `src`, e.g. `issuer` for `issuer/issuance/oid4vci/adapters/x.ts`. */
const capabilityOf = (file: string) => file.split("/")[0];

/**
 * Protocol and trust core, where the layered shape is required (see
 * "Scope: where the layering applies" in backend-architecture.md).
 * Administrative CRUD elsewhere may use TypeORM, ConfigService and HTTP
 * exceptions directly.
 */
const protocolCore = /^(issuer\/issuance|verifier|trust|session)\//;

/**
 * Debt tracked by the ratchet baseline, per source file and category.
 * Legacy files may not gain Express imports, legacy protocol-core files may not
 * gain ConfigService, TypeORM or Nest HTTP exception imports, adapters may not
 * throw Nest HTTP exceptions or reach into controllers, modules and other
 * capabilities' adapters, and controllers may not import adapters.
 * Migrations and generated code are not tracked.
 */
export function architectureDebt(
    graph: Map<string, Dependency[]>,
    root: string,
): Record<string, string[]> {
    const name = (file: string) => relative(root, file).replaceAll("\\", "/");
    const debt: Record<string, string[]> = {};
    for (const [file, dependencies] of graph) {
        const origin = name(file);
        if (/^database\/migrations\/|(^|\/)generated\//.test(origin)) continue;
        const role = roleOf(origin);
        const categories = new Set<string>();
        for (const dep of dependencies) {
            const target =
                dep.target && graph.has(dep.target)
                    ? name(dep.target)
                    : undefined;
            const httpException =
                dep.specifier === "@nestjs/common" &&
                dep.names.some((imported) => imported.endsWith("Exception"));
            if (role === "legacy") {
                if (/^express(\/|$)/.test(dep.specifier))
                    categories.add("express");
                if (!protocolCore.test(origin)) continue;
                if (/^@nestjs\/config(\/|$)/.test(dep.specifier))
                    categories.add("config");
                if (/^(typeorm|@nestjs\/typeorm)(\/|$)/.test(dep.specifier))
                    categories.add("typeorm");
                if (httpException) categories.add("http-exception");
            } else if (role === "adapter") {
                if (httpException) categories.add("http-exception");
                if (target && roleOf(target) === "controller")
                    categories.add("adapter->controller");
                if (target && roleOf(target) === "composition")
                    categories.add("adapter->module");
                if (
                    target &&
                    /(^|\/)adapters\//.test(target) &&
                    capabilityOf(target) !== capabilityOf(origin)
                )
                    categories.add("adapter->other-capability-adapter");
            } else if (
                role === "controller" &&
                target &&
                /(^|\/)adapters\//.test(target)
            ) {
                categories.add("controller->adapter");
            }
        }
        if (categories.size) debt[origin] = [...categories].sort();
    }
    return Object.fromEntries(
        Object.entries(debt).sort(([a], [b]) => a.localeCompare(b)),
    );
}

/** Compares current debt with the checked-in baseline in both directions. */
export function ratchetViolations(
    current: Record<string, string[]>,
    baseline: Record<string, string[]>,
): string[] {
    const violations: string[] = [];
    for (const [file, categories] of Object.entries(current))
        for (const category of categories)
            if (!baseline[file]?.includes(category))
                violations.push(
                    `${file}: new ${category} dependency not in architecture-baseline.json`,
                );
    for (const [file, categories] of Object.entries(baseline))
        for (const category of categories)
            if (!current[file]?.includes(category))
                violations.push(
                    `${file}: ${category} is gone, remove it from architecture-baseline.json`,
                );
    return violations;
}
