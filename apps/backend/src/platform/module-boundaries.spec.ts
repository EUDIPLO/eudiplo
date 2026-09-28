import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
    boundaryViolations,
    controllerPersistenceViolations,
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

describe("migrated application boundaries", () => {
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

    it("keeps migrated contracts and use cases in enforced locations", () => {
        const migrated = [
            "auth/tenant/domain/tenant-data.ts",
            "auth/tenant/ports/tenant.repository.ts",
            "issuer/configuration/issuance/domain/issuance-configuration.ts",
            "issuer/configuration/issuance/ports/issuance-config.repository.ts",
            "issuer/configuration/credentials/domain/credential-configuration.ts",
            "issuer/configuration/credentials/ports/credential-configuration.repository.ts",
            "issuer/configuration/credentials/credential-config/ports/credential-config.repository.ts",
            "issuer/configuration/credentials/application/issue-credential.ts",
            "issuer/configuration/credentials/ports/credential-generation-context.ts",
            "issuer/configuration/credentials/application/configured-credential-claims.provider.ts",
            "issuer/configuration/credentials/ports/credential-claims-configuration.ts",
            "issuer/configuration/credentials/ports/remote-credential-claims.ts",
            "issuer/configuration/attribute-provider/domain/attribute-provider-data.ts",
            "issuer/configuration/webhook-endpoint/domain/webhook-endpoint-data.ts",
            "issuer/issuance/oid4vci/domain/deferred-transaction-status.ts",
            "session/ports/session.repository.ts",
            "session/domain/session-state.ts",
            "session/domain/session-data.ts",
            "session/domain/session-outcome.ts",
            "session/application/create-session.ts",
            "session/application/update-session-for-tenant.ts",
            "session/application/session-errors.ts",
            "session/application/get-session-for-tenant.ts",
            "session/application/get-session-by-authorization-code.ts",
            "session/application/get-session-by-refresh-token.ts",
            "session/application/get-session-by-request-uri.ts",
            "session/application/get-session-for-wallet-request.ts",
            "session/application/get-session-for-internal-flow.ts",
            "session/application/get-iso18013-session.ts",
            "session/application/resolve-external-authorization-session.ts",
            "session/domain/session-list.ts",
            "session/application/list-sessions.ts",
            "session/application/delete-session.ts",
            "session/application/record-failed-tx-code-attempt.ts",
            "session/application/change-session-state.ts",
            "session/application/cleanup-sessions.ts",
            "session/application/initialize-session-metrics.ts",
            "session/domain/session-retention.ts",
            "session/ports/session-retention-policies.ts",
            "session/ports/session-event-publisher.ts",
            "session/ports/session-metrics.ts",
            "issuer/issuance/oid4vci/application/retrieve-credential-offer.ts",
            "issuer/issuance/oid4vci/application/record-credential-notification.ts",
            "issuer/issuance/oid4vci/application/build-credential-offer-grants.ts",
            "issuer/issuance/oid4vci/application/classify-authorization-server-token.ts",
            "issuer/issuance/oid4vci/application/resolve-authorized-credential-configuration.ts",
            "issuer/issuance/oid4vci/application/resolve-credential-proofs.ts",
            "issuer/issuance/oid4vci/application/validate-and-consume-credential-nonces.ts",
            "issuer/issuance/oid4vci/oid4vci-settings.ts",
            "issuer/configuration/credentials/domain/credential-claims.ts",
            "issuer/configuration/credentials/application/configured-credential-claims.provider.ts",
            "issuer/configuration/credentials/domain/credential-issuer-format.ts",
            "issuer/configuration/credentials/application/credential-issuer-format-registry.ts",
            "issuer/configuration/credentials/adapters/sdjwtvc-credential-issuer-format.ts",
            "issuer/configuration/credentials/adapters/mdoc-credential-issuer-format.ts",
            "webhook/ports/presentation-result-publisher.ts",
            "webhook/webhook-presentation-result-publisher.ts",
            "trust/ports/federation-resolver.ts",
            "trust/adapters/openid-federation-resolver.ts",
            "verifier/oid4vp/application/retrieve-presentation-request.ts",
            "auth/client/domain/client-data.ts",
            "auth/client/client.provider.ts",
            "issuer/issuance/oid4vci/ports/credential-nonce.repository.ts",
            "issuer/issuance/oid4vci/adapters/typeorm-credential-nonce.repository.ts",
            "issuer/issuance/oid4vci/adapters/credential-nonce-cleanup.job.ts",
            "issuer/issuance/oid4vci/ports/credential-notification-publisher.ts",
            "issuer/issuance/oid4vci/adapters/webhook-credential-notification-publisher.ts",
            "issuer/issuance/oid4vci/credential-nonce.module.ts",
            "issuer/issuance/oid4vci/nonce.service.ts",
        ];
        expect(
            migrated.filter((file) => !graph.has(resolve(sourceRoot, file))),
        ).toEqual([]);
    });

    it("keeps application, domain, and ports independent of infrastructure, including through barrels", () => {
        expect(boundaryViolations(graph, sourceRoot)).toEqual([]);
    });

    it("does not add controller persistence dependencies", () => {
        expect(controllerPersistenceViolations(graph, sourceRoot)).toEqual([]);
    });
});
