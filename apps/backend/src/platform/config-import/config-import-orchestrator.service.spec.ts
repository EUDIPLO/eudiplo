import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ConfigImportOrchestratorService,
    formatBlockingIssue,
} from "./config-import-orchestrator.service.js";

describe("formatBlockingIssue", () => {
    it("names the resource the issue belongs to", () => {
        expect(
            formatBlockingIssue({
                severity: "error",
                code: "TRUSTED_AUTHORITY_REQUIRED",
                path: "/spec/dcql_query/credentials",
                message: "Credential queries without trusted_authorities: pid.",
                resource: { kind: "PresentationConfig", id: "pid-request" },
            }),
        ).toBe(
            "TRUSTED_AUTHORITY_REQUIRED in PresentationConfig/pid-request at /spec/dcql_query/credentials: Credential queries without trusted_authorities: pid.",
        );
    });

    it("falls back to the bundle when the issue has no resource", () => {
        expect(
            formatBlockingIssue({
                severity: "required-input",
                code: "MISSING_INPUT",
                path: "/inputs",
                message: "Input missing.",
            }),
        ).toBe("MISSING_INPUT in bundle at /inputs: Input missing.");
    });
});

describe("tenant setup finish hook", () => {
    let configFolder: string;
    let calls: string[];

    beforeEach(() => {
        configFolder = mkdtempSync(join(tmpdir(), "eudiplo-orchestrator-"));
        mkdirSync(join(configFolder, "acme"));
        calls = [];
    });

    afterEach(() => {
        rmSync(configFolder, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    function orchestrator(
        runner: () => Promise<void>,
        finish: () => Promise<void>,
    ): ConfigImportOrchestratorService {
        const service = new ConfigImportOrchestratorService(
            { get: () => configFolder } as never,
            { resolve: () => "upsert" } as never,
        );
        service.registerTenantSetup(
            "tenants",
            async () => {
                calls.push("setup");
                return true;
            },
            async () => {
                calls.push("finish");
                await finish();
            },
        );
        service.registerPortableRunner("folder", async () => {
            calls.push("runner");
            await runner();
        });
        return service;
    }

    it("runs after the tenant's imports", async () => {
        await orchestrator(
            async () => undefined,
            async () => undefined,
        ).runImports();

        expect(calls).toEqual(["setup", "runner", "finish"]);
    });

    it("does not run when the imports fail", async () => {
        await orchestrator(
            async () => {
                throw new Error("plan blocked");
            },
            async () => undefined,
        ).runImports();

        expect(calls).toEqual(["setup", "runner"]);
    });

    it("reports the tenant as failed when it throws", async () => {
        const service = orchestrator(
            async () => undefined,
            async () => {
                throw new Error("defaultKeyChains in info.json is not applied");
            },
        );
        const warn = vi
            .spyOn(
                (service as unknown as { logger: { warn: () => void } }).logger,
                "warn",
            )
            .mockImplementation(() => undefined);
        vi.spyOn(
            (service as unknown as { logger: { error: () => void } }).logger,
            "error",
        ).mockImplementation(() => undefined);

        await service.runImports();

        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("1 failed tenant(s): acme"),
        );
    });
});
