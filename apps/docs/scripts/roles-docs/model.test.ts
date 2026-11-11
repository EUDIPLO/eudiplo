import assert from "node:assert/strict";
import { test } from "node:test";
import { readEndpoints, readRoles } from "./model.js";

const roleValues = new Map([
    ["Issuances", "issuance:manage"],
    ["Registrar", "registrar:manage"],
]);

const controller = (body: string) => `
@Secured([Role.Registrar])
@Controller("schema-metadata")
export class ExampleController {
${body}
}`;

test("reads roles with their comments", () => {
    const roles = readRoles(
        "role.enum.ts",
        `export enum Role {
    // to manage issuer resources
    Issuances = "issuance:manage",
}`,
    );
    assert.deepEqual(roles, [{ name: "Issuances", value: "issuance:manage", description: "To manage issuer resources" }]);
});

test("a handler's @Secured with match all replaces the class requirement", () => {
    const [endpoint] = readEndpoints(
        "example.controller.ts",
        controller(`
    @Post("publish")
    @Secured([Role.Issuances, Role.Registrar], { match: "all" })
    publish() {}`),
        roleValues,
    );
    assert.deepEqual(endpoint, {
        method: "POST",
        path: "/api/schema-metadata/publish",
        roles: ["issuance:manage", "registrar:manage"],
        match: "all",
    });
});

test("a handler without @Secured inherits the class requirement", () => {
    const [endpoint] = readEndpoints("example.controller.ts", controller(`    @Get()\n    list() {}`), roleValues);
    assert.deepEqual(endpoint, {
        method: "GET",
        path: "/api/schema-metadata",
        roles: ["registrar:manage"],
        match: "any",
    });
});

test("an explicit match any parses like the default", () => {
    const [endpoint] = readEndpoints(
        "example.controller.ts",
        controller(`    @Post()\n    @Secured([Role.Issuances, Role.Registrar], { match: "any" })\n    create() {}`),
        roleValues,
    );
    assert.equal(endpoint.match, "any");
});

test("a route guarded only by JwtAuthGuard accepts any valid access token", () => {
    const endpoints = readEndpoints(
        "example.controller.ts",
        `
@UseGuards(JwtAuthGuard)
@Controller("profile")
export class ProfileController {
    @Get()
    get() {}
}`,
        roleValues,
    );
    assert.deepEqual(endpoints, [{ method: "GET", path: "/api/profile", roles: [], match: "any" }]);
});

test("accepts the tenant option, which leaves the role check as it is", () => {
    for (const [secured, match] of [
        [`@Secured([Role.Issuances], { tenant: "optional" })`, "any"],
        [`@Secured([Role.Issuances], {})`, "any"],
        [`@Secured([Role.Issuances], { match: "all", tenant: "required" })`, "all"],
    ] as const) {
        const [endpoint] = readEndpoints(
            "example.controller.ts",
            controller(`    @Post()\n    ${secured}\n    create() {}`),
            roleValues,
        );
        assert.equal(endpoint.match, match);
    }
});

test("rejects options and role lists the guard would read differently", () => {
    for (const secured of [
        `@Secured([Role.Issuances], { match: "some" })`,
        `@Secured([Role.Issuances], { match: "all", other: true })`,
        `@Secured([Role.Issuances], { tenant: "none" })`,
        `@Secured([Role.Issuances], { toString: "any" })`,
        `@Secured([Role.Issuances], { match: "all", match: "any" })`,
        `@Secured([Role.Issuances], { match })`,
        `@Secured([Role.Issuances], options)`,
        `@Secured([], { match: "all" })`,
    ]) {
        assert.throws(
            () => readEndpoints("example.controller.ts", controller(`    @Post()\n    ${secured}\n    create() {}`), roleValues),
            /Unsupported @Secured/,
        );
    }
});
