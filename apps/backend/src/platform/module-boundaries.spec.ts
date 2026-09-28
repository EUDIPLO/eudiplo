import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
    architectureDebt,
    boundaryViolations,
    controllerPersistenceViolations,
    ratchetViolations,
    readGraph,
} from "../../test/architecture/dependency-rules.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const typescriptFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) return typescriptFiles(path);
        return entry.name.endsWith(".ts") ? [path] : [];
    });

describe("backend module boundaries", () => {
    it("keeps shared code independent from application features", () => {
        const sharedRoot = resolve(sourceRoot, "shared");
        const violations: string[] = [];

        for (const file of typescriptFiles(sharedRoot)) {
            const source = readFileSync(file, "utf8");
            for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
                const target = resolve(dirname(file), match[1]);
                if (relative(sharedRoot, target).startsWith("..")) {
                    violations.push(
                        `${relative(sourceRoot, file)} -> ${relative(sourceRoot, target)}`,
                    );
                }
            }
        }

        expect(violations).toEqual([]);
    });

    it("does not restore legacy catch-all locations", () => {
        const legacyDirectories = [
            "shared/trust",
            "shared/utils/config-import",
            "shared/utils/encryption",
            "shared/utils/logger",
            "shared/utils/webhook",
            "auth/tenant/entitites",
        ];

        expect(
            legacyDirectories.filter((directory) =>
                existsSync(resolve(sourceRoot, directory)),
            ),
        ).toEqual([]);
    });
});

describe("layer boundaries", () => {
    const configFile = resolve(sourceRoot, "../tsconfig.json");
    const config = ts.readConfigFile(configFile, ts.sys.readFile);
    const { options } = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        dirname(configFile),
    );
    const files = typescriptFiles(sourceRoot).filter(
        (file) => !file.endsWith(".spec.ts"),
    );
    const graph = readGraph(files, options);

    it("keeps application, domain, and ports independent of infrastructure, including through barrels", () => {
        expect(boundaryViolations(graph, sourceRoot)).toEqual([]);
    });

    it("does not add controller persistence dependencies", () => {
        expect(controllerPersistenceViolations(graph, sourceRoot)).toEqual([]);
    });

    // Regenerate with UPDATE_ARCHITECTURE_BASELINE=1 pnpm --filter @eudiplo/backend test
    it("does not add architecture debt beyond the ratchet baseline", () => {
        const baselineFile = resolve(
            sourceRoot,
            "../test/architecture/architecture-baseline.json",
        );
        const current = architectureDebt(graph, sourceRoot);
        if (process.env.UPDATE_ARCHITECTURE_BASELINE) {
            writeFileSync(
                baselineFile,
                `${JSON.stringify(current, null, 4)}\n`,
            );
        }
        const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
        expect(ratchetViolations(current, baseline)).toEqual([]);
    });
});
