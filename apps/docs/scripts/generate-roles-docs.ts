import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { GLOBAL_PREFIX_EXCLUSIONS } from "../../backend/src/main.helpers.js";

/**
 * Generates docs/_generated/roles.json for <RoleReference /> (reference/roles.md):
 * the roles of apps/backend/src/auth/roles/role.enum.ts with their comments, and
 * every management endpoint guarded by @Secured([...]) with the roles it accepts.
 */

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendSrc = resolve(scriptDir, "../../backend/src");
const roleEnumFile = join(backendSrc, "auth/roles/role.enum.ts");
const outputFile = resolve(scriptDir, "../docs/_generated/roles.json");

const HTTP_DECORATORS: Record<string, string> = {
    Get: "GET",
    Post: "POST",
    Put: "PUT",
    Patch: "PATCH",
    Delete: "DELETE",
    All: "ALL",
};

interface RoleDoc {
    /** Enum member name, e.g. `Presentations`. */
    name: string;
    /** Role value carried in access tokens, e.g. `presentation:manage`. */
    value: string;
    /** Comment of the enum member. */
    description: string;
}

interface EndpointDoc {
    method: string;
    path: string;
    /** Roles accepted by the endpoint (any one of them is enough). Empty: any valid access token. */
    roles: string[];
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

function readRoles(source: string): RoleDoc[] {
    const file = parse(roleEnumFile, source);
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
    if (roles.length === 0) throw new Error(`No Role enum found in ${roleEnumFile}`);
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

/** Roles of `@Secured([Role.A, Role.B])`, or `undefined` when the decorator is absent. */
function securedRoles(node: ts.Node, roleValues: Map<string, string>): string[] | undefined {
    for (const decorator of decorators(node)) {
        const call = decoratorCall(decorator);
        if (call?.name !== "Secured") continue;
        const [list] = call.args;
        if (!list || !ts.isArrayLiteralExpression(list)) {
            throw new Error(`Unsupported @Secured argument: ${decorator.getText()}`);
        }
        return list.elements.map((element) => {
            const member = ts.isPropertyAccessExpression(element) ? element.name.text : undefined;
            const value = member ? roleValues.get(member) : undefined;
            if (!value) throw new Error(`Unknown role in ${decorator.getText()}`);
            return value;
        });
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

function readEndpoints(file: string, source: string, roleValues: Map<string, string>): EndpointDoc[] {
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
            const roles = securedRoles(member, roleValues) ?? classRoles;
            if (!roles && !classGuarded && !usesJwtGuard(member)) continue;
            endpoints.push({
                method: HTTP_DECORATORS[route.name],
                path: publicPath(controllerPath, stringArgument(route.args)),
                roles: roles ?? [],
            });
        }
    });
    return endpoints;
}

async function controllerFiles(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".controller.ts"))
        .map((entry) => join(entry.parentPath, entry.name))
        .sort();
}

async function main() {
    const roles = readRoles(await fs.readFile(roleEnumFile, "utf8"));
    const roleValues = new Map(roles.map((role) => [role.name, role.value]));
    const endpoints: EndpointDoc[] = [];
    for (const file of await controllerFiles(backendSrc)) {
        endpoints.push(...readEndpoints(file, await fs.readFile(file, "utf8"), roleValues));
    }
    endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    await fs.mkdir(dirname(outputFile), { recursive: true });
    await fs.writeFile(outputFile, `${JSON.stringify({ roles, endpoints }, null, 2)}\n`, "utf8");
    console.log(`Generated ${roles.length} roles and ${endpoints.length} secured endpoints -> ${outputFile}`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
