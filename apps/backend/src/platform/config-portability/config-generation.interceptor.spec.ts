import { ConflictException } from "@nestjs/common";
import { firstValueFrom, of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { ConfigGenerationInterceptor } from "./config-generation.interceptor.js";

function context(request: Record<string, unknown>) {
    return {
        getType: () => "http",
        switchToHttp: () => ({ getRequest: () => request }),
    } as any;
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
            {
                run: async (_tenant: string, _mode: string, execute: any) =>
                    execute({ id: "run-1", operations: [] }),
                checkpoint: vi.fn(),
            } as any,
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
            {
                run: async (_tenant: string, _mode: string, execute: any) =>
                    execute({ id: "run-1", operations: [] }),
                checkpoint: vi.fn(),
            } as any,
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
            {
                run: async (_tenant: string, _mode: string, execute: any) =>
                    execute({ id: "run-1", operations: [] }),
                checkpoint: vi.fn(),
            } as any,
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

    it("passes MCP tool calls through", async () => {
        const routes = { match: vi.fn() };
        const interceptor = new ConfigGenerationInterceptor(
            {} as any,
            routes as any,
            {} as any,
        );
        const switchToHttp = vi.fn();

        await expect(
            firstValueFrom(
                interceptor.intercept(
                    { getType: () => "mcp", switchToHttp } as any,
                    { handle: () => of({ ok: true }) },
                ),
            ),
        ).resolves.toEqual({ ok: true });
        expect(switchToHttp).not.toHaveBeenCalled();
        expect(routes.match).not.toHaveBeenCalled();
    });
});
