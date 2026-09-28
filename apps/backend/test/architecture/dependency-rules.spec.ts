import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
    architectureDebt,
    boundaryViolations,
    controllerPersistenceViolations,
    ratchetViolations,
    readGraph,
} from "./dependency-rules.js";

const root = resolve("/architecture-fixture");
function graph(input: Record<string, string>) {
    const files = new Map(
        Object.entries(input).map(([name, source]) => [
            resolve(root, name),
            source,
        ]),
    );
    const host: ts.ModuleResolutionHost = {
        fileExists: (file) => files.has(file),
        readFile: (file) => files.get(file),
        directoryExists: (directory) =>
            [...files.keys()].some((file) => file.startsWith(`${directory}/`)),
        getCurrentDirectory: () => root,
    };
    return readGraph(
        [...files.keys()],
        {
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            paths: { "@feature/*": [`${root}/feature/*`] },
        },
        host,
    );
}

describe("architecture dependency rules", () => {
    it.each([
        'import type { Repository } from "typeorm";',
        'export type { Repository } from "typeorm";',
        'type Repo = import("typeorm").Repository<unknown>;',
        'const orm = await import("typeorm");',
        'const orm = require("typeorm");',
        'import orm = require("typeorm");',
        'import "typeorm";',
        'import { readFile } from "node:fs/promises";',
        'import { S3Client } from "@aws-sdk/client-s3";',
        'import { HttpService } from "@nestjs/axios";',
        'import { MetricService } from "nestjs-otel";',
        'import { metrics } from "@opentelemetry/api";',
        'import { BadRequestException as Failure } from "@nestjs/common";',
        'import { IsString } from "class-validator";',
        'import { plainToInstance } from "class-transformer";',
        'import { createZodDto } from "nestjs-zod";',
        'import { PinoLogger } from "nestjs-pino";',
        "const implementation = await import(selectedModule);",
    ])("rejects infrastructure dependency: %s", (source) => {
        expect(
            boundaryViolations(
                graph({ "feature/application/use-case.ts": source }),
                root,
            ),
        ).toHaveLength(1);
    });

    it("resolves .js specifiers, aliases, and re-exports through unclassified helpers", () => {
        const dependencies = graph({
            "feature/application/use-case.ts":
                'import type { Data } from "@feature/public.js";',
            "feature/public.ts": 'export type { Data } from "./helper.js";',
            "feature/helper.ts":
                'import type { Repository } from "typeorm"; export type Data = Repository<unknown>;',
        });
        expect(boundaryViolations(dependencies, root)).toEqual([
            expect.stringContaining(
                "@feature/public.js -> ./helper.js -> typeorm",
            ),
        ]);
    });

    it("rejects inward layers depending on adapters or outward layers even without SDK imports", () => {
        const dependencies = graph({
            "feature/application/use-case.ts":
                'import { adapter } from "../adapters/store.js";',
            "feature/adapters/store.ts": "export const adapter = {};",
            "feature/domain/rule.ts": 'import "../application/use-case.js";',
            "feature/ports/contract.ts": 'import "../application/use-case.js";',
        });
        expect(boundaryViolations(dependencies, root)).toHaveLength(3);
    });

    it("allows controller -> application -> port/domain and adapter -> port", () => {
        const dependencies = graph({
            "feature/feature.controller.ts":
                'import "./application/use-case.js";',
            "feature/application/use-case.ts":
                'import "../ports/store.js"; import "../domain/rule.js";',
            "feature/ports/store.ts": 'import "../domain/rule.js";',
            "feature/domain/rule.ts": "export const rule = true;",
            "feature/adapters/store.ts":
                'import "../ports/store.js"; import "typeorm";',
        });
        expect(boundaryViolations(dependencies, root)).toEqual([]);
        expect(controllerPersistenceViolations(dependencies, root)).toEqual([]);
    });

    it("rejects direct controller repository access and repository barrel exports", () => {
        const dependencies = graph({
            "feature/feature.controller.ts": 'import "./public.js";',
            "feature/public.ts":
                'export * from "./ports/session.repository.js";',
            "feature/ports/session.repository.ts":
                "export interface SessionRepository {}",
            "other/other.controller.ts":
                'import type { Repository } from "typeorm";',
        });
        expect(
            controllerPersistenceViolations(dependencies, root),
        ).toHaveLength(2);
    });

    it("follows renamed imports forwarded by a local export", () => {
        const dependencies = graph({
            "feature/feature.controller.ts":
                'import { Store } from "./public.js";',
            "feature/public.ts":
                'import type { Repository as Store } from "typeorm"; export type { Store };',
        });
        expect(
            controllerPersistenceViolations(dependencies, root),
        ).toHaveLength(1);
    });

    it("keeps domain and ports framework-independent while permitting application DI", () => {
        const dependencies = graph({
            "feature/application/use-case.ts":
                'import { Injectable, Inject } from "@nestjs/common";',
            "feature/domain/rule.ts":
                'import { Injectable } from "@nestjs/common";',
            "feature/ports/store.ts":
                'import { Injectable } from "@nestjs/common";',
        });
        expect(boundaryViolations(dependencies, root)).toHaveLength(2);
    });

    it("reports missing local dependencies instead of silently ignoring them", () => {
        expect(
            boundaryViolations(
                graph({
                    "feature/application/use-case.ts":
                        'import "../missing.js";',
                }),
                root,
            ),
        ).toEqual([expect.stringContaining("unresolved local dependency")]);
    });

    it("records legacy framework debt and adapter HTTP exceptions", () => {
        const legacyImports = [
            'import { ConfigService } from "@nestjs/config";',
            'import { InjectRepository } from "@nestjs/typeorm";',
            'import type { Request } from "express";',
            'import { Injectable, NotFoundException as Missing } from "@nestjs/common";',
        ].join("\n");
        const dependencies = graph({
            // Protocol core: all legacy categories are tracked.
            "verifier/feature.service.ts": legacyImports,
            // Administrative CRUD: only Express is tracked.
            "feature/feature.service.ts": legacyImports,
            "feature/adapters/store.ts":
                'import { ConflictException } from "@nestjs/common"; import "typeorm";',
            "feature/feature.module.ts":
                'import { ConfigModule } from "@nestjs/config";',
            "feature/feature.controller.ts":
                'import { BadRequestException } from "@nestjs/common";',
            "database/migrations/1-init.ts": 'import "typeorm";',
        });
        expect(architectureDebt(dependencies, root)).toEqual({
            "feature/adapters/store.ts": ["http-exception"],
            "feature/feature.service.ts": ["express"],
            "verifier/feature.service.ts": [
                "config",
                "express",
                "http-exception",
                "typeorm",
            ],
        });
    });

    it("records adapters reaching into controllers, modules, or other capabilities' adapters", () => {
        const dependencies = graph({
            "feature/adapters/store.ts": [
                'import "../feature.controller.js";',
                'import "../feature.module.js";',
                'import "../../other/adapters/client.js";',
                'import "../sub/adapters/helper.js";',
            ].join("\n"),
            "feature/feature.controller.ts": 'import "./adapters/store.js";',
            "feature/feature.module.ts": 'import "./adapters/store.js";',
            "feature/sub/adapters/helper.ts": "export {};",
            "other/adapters/client.ts": "export {};",
        });
        expect(architectureDebt(dependencies, root)).toEqual({
            "feature/adapters/store.ts": [
                "adapter->controller",
                "adapter->module",
                "adapter->other-capability-adapter",
            ],
            "feature/feature.controller.ts": ["controller->adapter"],
        });
    });

    it("fails on new debt and on stale baseline entries", () => {
        expect(
            ratchetViolations(
                { "a.service.ts": ["config", "typeorm"] },
                { "a.service.ts": ["config"], "b.service.ts": ["express"] },
            ),
        ).toEqual([
            "a.service.ts: new typeorm dependency not in architecture-baseline.json",
            "b.service.ts: express is gone, remove it from architecture-baseline.json",
        ]);
    });
});
