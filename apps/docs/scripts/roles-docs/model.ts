import ts from "typescript";
import { GLOBAL_PREFIX_EXCLUSIONS } from "../../../backend/src/main.helpers.js";

/**
 * Reads the roles of apps/backend/src/auth/roles/role.enum.ts and the
 * @Secured([...]) requirements of controller sources for generate-roles-docs.ts.
 */

const HTTP_DECORATORS: Record<string, string> = {
    Get: "GET",
    Post: "POST",
    Put: "PUT",
    Patch: "PATCH",
    Delete: "DELETE",
    All: "ALL",
};

export interface RoleDoc {
    /** Enum member name, e.g. `Presentations`. */
    name: string;
    /** Role value carried in access tokens, e.g. `presentation:manage`. */
    value: string;
    /** Comment of the enum member. */
    description: string;
}

type RoleMatch = "any" | "all";

interface RoleRequirement {
    /** Empty: any valid access token (JwtAuthGuard without @Secured). */
    roles: string[];
    /** `any`: one of the roles is enough. `all`: the token needs every role. */
    match: RoleMatch;
}

export interface EndpointDoc extends RoleRequirement {
    method: string;
    path: string;
}

function parse(file: string, source: string): ts.SourceFile {
    return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
}

/** Comment text directly above a node (`// …` lines or a JSDoc block). */
function leadingComment(node: ts.Node, source: string): string {
    const ranges = ts.getLeadingCommentRanges(source, node.getFullStart()) ?? [];
    return ranges
        .map((range) =>
            source
                .slice(range.pos, range.end)
                .replace(/^\/\*\*?|\*\/$/g, "")
                .split("\n")
                .map((line) => line.replace(/^\s*(\/\/|\*)?\s?/, "").trim())
                .filter(Boolean)
                .join(" "),
        )
        .join(" ")
        .trim();
}

export function readRoles(fileName: string, source: string): RoleDoc[] {
    const file = parse(fileName, source);
    const roles: RoleDoc[] = [];
    file.forEachChild((node) => {
        if (!ts.isEnumDeclaration(node) || node.name.text !== "Role") return;
        for (const member of node.members) {
            if (!member.initializer || !ts.isStringLiteral(member.initializer)) {
                throw new Error(`Role.${member.name.getText(file)} has no string value`);
            }
            const description = leadingComment(member, source);
            roles.push({
                name: member.name.getText(file),
                value: member.initializer.text,
                description: description.charAt(0).toUpperCase() + description.slice(1),
            });
        }
    });
    if (roles.length === 0) throw new Error(`No Role enum found in ${fileName}`);
    return roles;
}

function decorators(node: ts.Node): ts.Decorator[] {
    return ts.canHaveDecorators(node) ? [...(ts.getDecorators(node) ?? [])] : [];
}

function decoratorCall(decorator: ts.Decorator): { name: string; args: readonly ts.Expression[] } | undefined {
    const expression = decorator.expression;
    if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) return undefined;
    return { name: expression.expression.text, args: expression.arguments };
}

function stringArgument(args: readonly ts.Expression[]): string {
    const [first] = args;
    if (!first) return "";
    if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text;
    throw new Error(`Unsupported route argument: ${first.getText()}`);
}

/**
 * `match` of `@Secured([...], { match: "all" })`, `any` when absent. The
 * `tenant` option does not change the role check and is only validated.
 */
function securedMatch(decorator: ts.Decorator, options: ts.Expression | undefined): RoleMatch {
    if (!options) return "any";
    const allowed: Record<string, string[]> = { match: ["any", "all"], tenant: ["required", "optional"] };
    const values: Record<string, string> = {};
    if (ts.isObjectLiteralExpression(options)) {
        for (const property of options.properties) {
            const name = ts.isPropertyAssignment(property) ? property.name.getText() : undefined;
            if (
                !name ||
                !Object.hasOwn(allowed, name) ||
                name in values ||
                !ts.isStringLiteral(property.initializer) ||
                !allowed[name].includes(property.initializer.text)
            ) {
                throw new Error(`Unsupported @Secured options: ${decorator.getText()}`);
            }
            values[name] = property.initializer.text;
        }
        return (values.match ?? "any") as RoleMatch;
    }
    throw new Error(`Unsupported @Secured options: ${decorator.getText()}`);
}

/** Roles of `@Secured([Role.A, Role.B], options?)`, or `undefined` when the decorator is absent. */
function securedRoles(node: ts.Node, roleValues: Map<string, string>): RoleRequirement | undefined {
    for (const decorator of decorators(node)) {
        const call = decoratorCall(decorator);
        if (call?.name !== "Secured") continue;
        const [list, options] = call.args;
        if (!list || !ts.isArrayLiteralExpression(list) || list.elements.length === 0) {
            throw new Error(`Unsupported @Secured argument: ${decorator.getText()}`);
        }
        const roles = list.elements.map((element) => {
            const member = ts.isPropertyAccessExpression(element) ? element.name.text : undefined;
            const value = member ? roleValues.get(member) : undefined;
            if (!value) throw new Error(`Unknown role in ${decorator.getText()}`);
            return value;
        });
        return { roles, match: securedMatch(decorator, options) };
    }
    return undefined;
}

function usesJwtGuard(node: ts.Node): boolean {
    return decorators(node).some((decorator) => {
        const call = decoratorCall(decorator);
        return call?.name === "UseGuards" && call.args.some((arg) => arg.getText() === "JwtAuthGuard");
    });
}

/** Turn a Nest route pattern (`:param`, `{*path}`) into a regular expression. */
function routePattern(path: string): RegExp {
    const escaped = path
        .replace(/^\//, "")
        .split("/")
        .map((segment) => {
            if (segment.startsWith(":")) return "[^/]+";
            if (/^\{\*\w+\}$/.test(segment)) return ".*";
            return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/");
    return new RegExp(`^${escaped}$`);
}

const exclusions = GLOBAL_PREFIX_EXCLUSIONS.map((exclusion) => routePattern(exclusion.path));

/** Public path of a route: management routes get the global `/api` prefix (see main.helpers.ts). */
function publicPath(controllerPath: string, routePath: string): string {
    const path = [controllerPath, routePath]
        .flatMap((part) => part.split("/"))
        .filter(Boolean)
        .join("/");
    return exclusions.some((pattern) => pattern.test(path)) ? `/${path}` : `/api/${path}`;
}

export function readEndpoints(file: string, source: string, roleValues: Map<string, string>): EndpointDoc[] {
    const sourceFile = parse(file, source);
    const endpoints: EndpointDoc[] = [];
    sourceFile.forEachChild((node) => {
        if (!ts.isClassDeclaration(node)) return;
        const controller = decorators(node)
            .map(decoratorCall)
            .find((call) => call?.name === "Controller");
        if (!controller) return;
        const controllerPath = stringArgument(controller.args);
        const classRoles = securedRoles(node, roleValues);
        const classGuarded = usesJwtGuard(node);
        for (const member of node.members) {
            if (!ts.isMethodDeclaration(member)) continue;
            const route = decorators(member)
                .map(decoratorCall)
                .find((call) => call && call.name in HTTP_DECORATORS);
            if (!route) continue;
            // RolesGuard reads the handler metadata first and falls back to the class.
            const requirement = securedRoles(member, roleValues) ?? classRoles;
            if (!requirement && !classGuarded && !usesJwtGuard(member)) continue;
            endpoints.push({
                method: HTTP_DECORATORS[route.name],
                path: publicPath(controllerPath, stringArgument(route.args)),
                ...(requirement ?? { roles: [], match: "any" }),
            });
        }
    });
    return endpoints;
}
