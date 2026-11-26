import { readFileSync } from "node:fs";
import { Logger, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
    CLOUD_CREDENTIAL_VARIABLES,
    declaredScopes,
} from "../config/config-variable-scope.js";
import { EnvSecretSource } from "./adapters/env-secret-source.js";
import { readSecretPolicyFile } from "./adapters/secret-policy-file.js";
import {
    SECRET_REFERENCES,
    SecretReferences,
} from "./application/secret-references.js";
import {
    DEFAULT_SECRET_RESOLVER_OPTIONS,
    SecretResolver,
} from "./application/secret-resolver.js";
import { SecretPolicyError } from "./domain/secret-errors.js";

/**
 * Secret references in secret fields, read under the operator's policy
 * file (`SECRET_POLICY_FILE`). Without the setting nothing is read and
 * every value is a literal. An invalid file stops the startup.
 */
export function createSecretReferences(
    config: Pick<ConfigService, "get">,
    env: Readonly<Record<string, string | undefined>> = process.env,
    readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): SecretReferences {
    const path = config.get<string>("SECRET_POLICY_FILE");
    if (!path) return new SecretReferences();
    let text: string;
    try {
        text = readFile(path);
    } catch (error) {
        throw new SecretPolicyError([
            `SECRET_POLICY_FILE ${path} cannot be read: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
        ]);
    }
    const { policy } = readSecretPolicyFile({
        text,
        env,
        envSource: (variables) =>
            new EnvSecretSource(
                variables,
                declaredScopes(),
                CLOUD_CREDENTIAL_VARIABLES,
            ),
    });
    const logger = new Logger("SecretReferences");
    logger.log(`Secret references are read under the policy in ${path}`);
    return new SecretReferences(
        new SecretResolver(policy, {
            ...DEFAULT_SECRET_RESOLVER_OPTIONS,
            onStale: (reference, cause) => {
                const reason =
                    cause instanceof Error ? ` (${cause.message})` : "";
                logger.warn(
                    `${reference}: its source failed, the last value is used${reason}`,
                );
            },
        }),
    );
}

@Module({
    providers: [
        {
            provide: SECRET_REFERENCES,
            inject: [ConfigService],
            useFactory: (config: ConfigService) =>
                createSecretReferences(config),
        },
    ],
    exports: [SECRET_REFERENCES],
})
export class SecretsModule {}
