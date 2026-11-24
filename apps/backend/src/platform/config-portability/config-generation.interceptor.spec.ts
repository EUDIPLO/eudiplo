import { ConflictException } from "@nestjs/common";
import { firstValueFrom, of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { ConfigGenerationInterceptor } from "./config-generation.interceptor.js";

function context(request: Record<string, unknown>) {
    return {
        switchToHttp: () => ({ getRequest: () => request }),
    } as any;
}

function journal() {
    return {
        run: vi.fn(async (_tenant: string, _mode: string, execute: any) =>
            execute({ id: "run-1", operations: [] }),
        ),
        checkpoint: vi.fn(),
    };
}

describe("ConfigGenerationInterceptor", () => {
    it("does not apply ownership rules to reads", async () => {
        const ownership = {
            assertMutable: vi.fn(),
            recordApiMutation: vi.fn(),
            remove: vi.fn(),
        };
        const routes = { match: vi.fn() };
        const interceptor = new ConfigGenerationInterceptor(
            ownership as any,
            routes as any,
            journal() as any,
            { getClientById: vi.fn() } as any,
        );

        await expect(
            firstValueFrom(
                interceptor.intercept(
                    context({
                        method: "GET",
                        path: "/api/client/automation",
                        user: { entity: { id: "tenant-a" } },
                    }),
                    { handle: () => of({ clientId: "automation" }) },
                ),
            ),
        ).resolves.toEqual({ clientId: "automation" });
        expect(routes.match).not.toHaveBeenCalled();
        expect(ownership.assertMutable).not.toHaveBeenCalled();
    });

    it.each([
        "/api/key-chain/import",
        "/api/key-chain/import/",
        "/key-chain/import",
    ])(
        "runs a key import without an ID under the tenant's configuration lock (%s)",
        async (path) => {
            const ownership = {
                assertMutable: vi.fn(),
                recordApiMutation: vi.fn(),
                remove: vi.fn(),
            };
            const writes = journal();
            const order: string[] = [];
            writes.run.mockImplementation(
                async (_tenant: string, _mode: string, execute: any) => {
                    order.push("locked");
                    const result = await execute({
                        id: "run-1",
                        operations: [],
                    });
                    order.push("released");
                    return result;
                },
            );
            const interceptor = new ConfigGenerationInterceptor(
                ownership as any,
                { match: vi.fn(() => undefined) } as any,
                writes as any,
                { getClientById: vi.fn() } as any,
            );

            await expect(
                firstValueFrom(
                    interceptor.intercept(
                        context({
                            method: "POST",
                            path,
                            body: { key: {} },
                            user: { entity: { id: "tenant-a" } },
                        }),
                        {
                            handle: () => {
                                order.push("imported");
                                return of({ id: "generated" });
                            },
                        },
                    ),
                ),
            ).resolves.toEqual({ id: "generated" });

            expect(writes.run).toHaveBeenCalledWith(
                "tenant-a",
                "api",
                expect.any(Function),
            );
            expect(order).toEqual(["locked", "imported", "released"]);
            expect(writes.checkpoint).toHaveBeenCalledWith(
                expect.objectContaining({
                    operations: [{ stage: "resource", status: "completed" }],
                }),
            );
            // No resource is named, so nothing is recorded as managed.
            expect(ownership.assertMutable).not.toHaveBeenCalled();
            expect(ownership.recordApiMutation).not.toHaveBeenCalled();
        },
    );

    it("blocks a file-managed mutation before invoking the handler", async () => {
        const ownership = {
            assertMutable: vi
                .fn()
                .mockRejectedValue(new ConflictException("file-managed")),
            recordApiMutation: vi.fn(),
            remove: vi.fn(),
        };
        const routes = {
            match: vi.fn(() => ({
                kind: "CredentialConfig",
                id: "pid",
                create: false,
            })),
        };
        const next = { handle: vi.fn(() => of({ ok: true })) };
        const interceptor = new ConfigGenerationInterceptor(
            ownership as any,
            routes as any,
            journal() as any,
            { getClientById: vi.fn() } as any,
        );

        await expect(
            firstValueFrom(
                interceptor.intercept(
                    context({
                        method: "PATCH",
                        path: "/api/issuer/credentials/pid",
                        body: {},
                        user: { entity: { id: "tenant-a" } },
                    }),
                    next,
                ),
            ),
        ).rejects.toThrow("file-managed");
        expect(next.handle).not.toHaveBeenCalled();
        expect(ownership.recordApiMutation).not.toHaveBeenCalled();
    });

    it("records the new generation only after a successful mutation", async () => {
        const ownership = {
            assertMutable: vi.fn().mockResolvedValue(undefined),
            recordApiMutation: vi.fn().mockResolvedValue(undefined),
            remove: vi.fn(),
        };
        const routes = {
            match: vi.fn(() => ({
                kind: "Client",
                id: "automation",
                create: true,
            })),
        };
        const interceptor = new ConfigGenerationInterceptor(
            ownership as any,
            routes as any,
            journal() as any,
            { getClientById: vi.fn() } as any,
        );

        await expect(
            firstValueFrom(
                interceptor.intercept(
                    context({
                        method: "POST",
                        path: "/api/client",
                        body: { clientId: "automation" },
                        user: { entity: { id: "tenant-a" } },
                    }),
                    { handle: () => of({ ok: true }) },
                ),
            ),
        ).resolves.toEqual({ ok: true });
        expect(ownership.assertMutable).toHaveBeenCalledWith(
            "tenant-a",
            "Client",
            "automation",
        );
        expect(ownership.recordApiMutation).toHaveBeenCalledWith(
            "tenant-a",
            "Client",
            "automation",
            true,
        );
    });

    describe("rotating the secret of another tenant's client", () => {
        const rotate = (user: Record<string, unknown>) =>
            context({
                method: "POST",
                path: "/api/client/automation/rotate-secret",
                body: {},
                user,
            });
        const rotateRoute = {
            match: vi.fn(() => ({
                kind: "Client",
                id: "automation",
                create: false,
                crossTenant: true,
            })),
        };

        function setup(
            clientTenant: string | null | undefined,
            routes: { match: () => unknown } = rotateRoute,
        ) {
            const ownership = {
                assertMutable: vi.fn().mockResolvedValue(undefined),
                recordApiMutation: vi.fn().mockResolvedValue(undefined),
                remove: vi.fn(),
            };
            const clients = {
                getClientById: vi.fn(async () =>
                    clientTenant === undefined
                        ? null
                        : { clientId: "automation", tenantId: clientTenant },
                ),
            };
            const runs = journal();
            const interceptor = new ConfigGenerationInterceptor(
                ownership as any,
                routes as any,
                runs as any,
                clients as any,
            );
            return { ownership, clients, run: runs.run, interceptor };
        }

        it("refuses a file-managed client to an operator without a tenant", async () => {
            const { ownership, interceptor } = setup("tenant-b");
            ownership.assertMutable.mockRejectedValue(
                new ConflictException("file-managed"),
            );
            const next = { handle: vi.fn(() => of({ secret: "s" })) };

            await expect(
                firstValueFrom(
                    interceptor.intercept(
                        rotate({ roles: ["tenants:manage"] }),
                        next,
                    ),
                ),
            ).rejects.toThrow("file-managed");
            expect(ownership.assertMutable).toHaveBeenCalledWith(
                "tenant-b",
                "Client",
                "automation",
            );
            expect(next.handle).not.toHaveBeenCalled();
        });

        it("checks and records the client's tenant, not the one of a tenant manager", async () => {
            const { ownership, run, interceptor } = setup("tenant-b");

            await expect(
                firstValueFrom(
                    interceptor.intercept(
                        rotate({
                            entity: { id: "tenant-a" },
                            roles: ["tenants:manage", "clients:manage"],
                        }),
                        { handle: () => of({ secret: "s" }) },
                    ),
                ),
            ).resolves.toEqual({ secret: "s" });
            expect(run).toHaveBeenCalledWith(
                "tenant-b",
                "api",
                expect.any(Function),
            );
            expect(ownership.assertMutable).toHaveBeenCalledWith(
                "tenant-b",
                "Client",
                "automation",
            );
            expect(ownership.recordApiMutation).toHaveBeenCalledWith(
                "tenant-b",
                "Client",
                "automation",
                false,
            );
            expect(ownership.assertMutable).not.toHaveBeenCalledWith(
                "tenant-a",
                expect.anything(),
                expect.anything(),
            );
        });

        it.each([
            ["an unknown client", undefined],
            ["a client without a tenant", null],
        ])("leaves %s to the handler", async (_, clientTenant) => {
            const { ownership, run, interceptor } = setup(clientTenant);
            const next = { handle: vi.fn(() => of({ secret: "s" })) };

            await expect(
                firstValueFrom(
                    interceptor.intercept(
                        rotate({
                            entity: { id: "tenant-a" },
                            roles: ["tenants:manage"],
                        }),
                        next,
                    ),
                ),
            ).resolves.toEqual({ secret: "s" });
            expect(next.handle).toHaveBeenCalled();
            expect(run).not.toHaveBeenCalled();
            expect(ownership.assertMutable).not.toHaveBeenCalled();
            expect(ownership.recordApiMutation).not.toHaveBeenCalled();
        });

        it("fails before the handler when the client lookup fails", async () => {
            const { ownership, clients, run, interceptor } = setup("tenant-b");
            clients.getClientById.mockRejectedValue(new Error("db down"));
            const next = { handle: vi.fn(() => of({ secret: "s" })) };

            await expect(
                firstValueFrom(
                    interceptor.intercept(
                        rotate({ roles: ["tenants:manage"] }),
                        next,
                    ),
                ),
            ).rejects.toThrow("db down");
            expect(next.handle).not.toHaveBeenCalled();
            expect(run).not.toHaveBeenCalled();
            expect(ownership.assertMutable).not.toHaveBeenCalled();
        });

        it("keeps a client manager to its own tenant without a lookup", async () => {
            const { ownership, clients, interceptor } = setup("tenant-b");

            await firstValueFrom(
                interceptor.intercept(
                    rotate({
                        entity: { id: "tenant-a" },
                        roles: ["clients:manage"],
                    }),
                    { handle: () => of({ secret: "s" }) },
                ),
            );
            expect(clients.getClientById).not.toHaveBeenCalled();
            expect(ownership.assertMutable).toHaveBeenCalledWith(
                "tenant-a",
                "Client",
                "automation",
            );
        });

        it("keeps a tenant manager's own tenant on other client routes", async () => {
            const { ownership, clients, interceptor } = setup("tenant-b", {
                match: () => ({
                    kind: "Client",
                    id: "automation",
                    create: false,
                }),
            });

            await firstValueFrom(
                interceptor.intercept(
                    context({
                        method: "PATCH",
                        path: "/api/client/automation",
                        body: {},
                        user: {
                            entity: { id: "tenant-a" },
                            roles: ["tenants:manage", "clients:manage"],
                        },
                    }),
                    { handle: () => of({ ok: true }) },
                ),
            );
            expect(clients.getClientById).not.toHaveBeenCalled();
            expect(ownership.assertMutable).toHaveBeenCalledWith(
                "tenant-a",
                "Client",
                "automation",
            );
        });
    });
});
