import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RequestMethod, type Type } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { beforeAll, describe, expect, it } from "vitest";
import { rolesAllow } from "../../../test/roles-guard.js";
import { allRoles, Role } from "../../auth/roles/role.enum.js";
import { ConfigPortabilityController } from "./config-portability.controller.js";
import {
    CONFIG_RESOURCE_KINDS,
    type ConfigResourceKind,
} from "./config-resource.types.js";
import {
    mayExportConfigDocument,
    mayReadConfigOwnership,
} from "./config-resource-access.js";
import { ConfigResourceRouteService } from "./config-resource-route.service.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const WRITE_METHODS = new Set([
    RequestMethod.POST,
    RequestMethod.PUT,
    RequestMethod.PATCH,
    RequestMethod.DELETE,
]);

/** Every controller class of the backend, so a new one cannot be missed. */
async function loadControllers(): Promise<Type[]> {
    const files = readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".controller.ts"))
        .sort();
    const modules = await Promise.all(
        files.map((file) => import(join(sourceRoot, file))),
    );
    return modules.flatMap((module) =>
        Object.values(module).filter(
            (value): value is Type =>
                typeof value === "function" &&
                Reflect.hasMetadata(PATH_METADATA, value),
        ),
    );
}

/** Every write route that ConfigResourceRouteService maps to a kind, with its roles. */
function configWrites(controllers: Type[]) {
    const routes = new ConfigResourceRouteService();
    return controllers.flatMap((controller) =>
        Object.getOwnPropertyNames(controller.prototype).flatMap((name) => {
            const handler = controller.prototype[name];
            const method = Reflect.getMetadata(METHOD_METADATA, handler);
            if (!WRITE_METHODS.has(method)) return [];
            const path =
                `/${Reflect.getMetadata(PATH_METADATA, controller)}/${Reflect.getMetadata(PATH_METADATA, handler)}`
                    .replaceAll(/:\w+/g, "sample")
                    .replaceAll(/\/+/g, "/");
            const resource = routes.match(RequestMethod[method], path, {
                id: "sample",
                clientId: "sample",
            });
            if (!resource) return [];
            // The roles that pass RolesGuard on their own for this handler.
            const roles = allRoles.filter((role) =>
                rolesAllow(controller, name, [role]),
            );
            return [
                {
                    route: `${RequestMethod[method]} ${path}`,
                    ...resource,
                    roles,
                },
            ];
        }),
    );
}

describe("mayReadConfigOwnership", () => {
    let writes: ReturnType<typeof configWrites>;

    beforeAll(async () => {
        writes = configWrites(await loadControllers());
    }, 60_000);

    it("admits the admin roles for every kind", () => {
        for (const kind of CONFIG_RESOURCE_KINDS) {
            expect(mayReadConfigOwnership([Role.TenantAdmin], kind)).toBe(true);
            expect(mayReadConfigOwnership([Role.Tenants], kind)).toBe(true);
        }
    });

    it("admits a manage role only for the kinds it changes", () => {
        const roles = [Role.Presentations, Role.PresentationRequest];
        expect(mayReadConfigOwnership(roles, "PresentationConfig")).toBe(true);
        expect(mayReadConfigOwnership(roles, "TrustList")).toBe(true);
        expect(mayReadConfigOwnership(roles, "CredentialConfig")).toBe(false);
        expect(mayReadConfigOwnership(roles, "Client")).toBe(false);
        expect(mayReadConfigOwnership([Role.Issuances], "KmsConfig")).toBe(
            false,
        );
        expect(mayReadConfigOwnership(undefined, "Tenant")).toBe(false);
    });

    it("sees only write routes that a single role may call", () => {
        // A route that needs several roles together has no single writer role;
        // the read rule would need a combined check, so it has to revisit the map.
        expect(
            writes
                .filter(({ roles }) => roles.length === 0)
                .map(({ route }) => route),
        ).toEqual([]);
    });

    it("admits exactly the admin roles and the roles that change each kind", () => {
        const admitted = (kind: string) =>
            [
                ...new Set(
                    allRoles.filter((role) =>
                        mayReadConfigOwnership(
                            [role],
                            kind as ConfigResourceKind,
                        ),
                    ),
                ),
            ].sort();
        const writers = (kind: string) =>
            [
                ...new Set([
                    Role.Tenants,
                    Role.TenantAdmin,
                    ...writes
                        .filter((write) => write.kind === kind)
                        .flatMap((write) => write.roles),
                ]),
            ].sort();

        expect(
            Object.fromEntries(
                CONFIG_RESOURCE_KINDS.map((kind) => [kind, admitted(kind)]),
            ),
        ).toEqual(
            Object.fromEntries(
                CONFIG_RESOURCE_KINDS.map((kind) => [kind, writers(kind)]),
            ),
        );
        // Every kind has at least one write route, so a missed controller shows up.
        expect(new Set(writes.map(({ kind }) => kind))).toEqual(
            new Set(CONFIG_RESOURCE_KINDS),
        );
    });

    it("matches the roles of the ownership endpoint's guard", () => {
        const readers = allRoles.filter((role) =>
            CONFIG_RESOURCE_KINDS.some((kind) =>
                mayReadConfigOwnership([role], kind),
            ),
        );
        const guarded = allRoles.filter((role) =>
            rolesAllow(ConfigPortabilityController, "resourcesOfKind", [role]),
        );

        expect(guarded).toEqual(readers);
    });
});

describe("mayExportConfigDocument", () => {
    it("needs an admin role for a key chain, which carries private keys", () => {
        for (const role of [Role.Keys, Role.Issuances, Role.Presentations]) {
            expect(mayExportConfigDocument([role], "KeyChain")).toBe(false);
        }
        expect(mayExportConfigDocument([Role.TenantAdmin], "KeyChain")).toBe(
            true,
        );
        expect(mayExportConfigDocument([Role.Tenants], "KeyChain")).toBe(true);
    });

    it("keeps keys:manage, which only changes the default access key chain, out of the tenant document", () => {
        expect(mayReadConfigOwnership([Role.Keys], "Tenant")).toBe(true);
        expect(mayExportConfigDocument([Role.Keys], "Tenant")).toBe(false);
        expect(mayExportConfigDocument([Role.Issuances], "Tenant")).toBe(true);
    });

    it("follows the ownership rule for every other kind", () => {
        for (const kind of CONFIG_RESOURCE_KINDS.filter(
            (kind) => kind !== "KeyChain" && kind !== "Tenant",
        )) {
            for (const role of allRoles) {
                expect(mayExportConfigDocument([role], kind)).toBe(
                    mayReadConfigOwnership([role], kind),
                );
            }
        }
    });

    it("matches the roles of the document endpoint's guard", () => {
        const exporters = allRoles.filter((role) =>
            CONFIG_RESOURCE_KINDS.some((kind) =>
                mayExportConfigDocument([role], kind),
            ),
        );
        const guarded = allRoles.filter((role) =>
            rolesAllow(ConfigPortabilityController, "exportDocument", [role]),
        );

        expect(guarded).toEqual(exporters);
    });
});
