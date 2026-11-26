import { readFileSync } from "node:fs";
import { Logger, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
    CONFIG_TEMPLATE_POLICY,
    type ConfigTemplatePolicy,
} from "../config/config-template-policy.js";
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

/** What the operator's secret policy file sets. */
export interface SecretSettings {
    references: SecretReferences;
    templates: ConfigTemplatePolicy;
}

const SECRET_SETTINGS = Symbol("SECRET_SETTINGS");

/**
 * The operator's secret policy file (`SECRET_POLICY_FILE`): secret
 * references in secret fields, read under its grants, and what `${VAR}`
 * placeholders of tenant folders may name. Without the setting no
 * reference is read, every value is a literal, and placeholders follow the
 * rules they followed before. An invalid file stops the startup.
 */
export function loadSecretSettings(
    config: Pick<ConfigService, "get">,
    env: Readonly<Record<string, string | undefined>> = process.env,
    readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): SecretSettings {
    const path = config.get<string>("SECRET_POLICY_FILE");
    if (!path) return { references: new SecretReferences(), templates: {} };
    let text: string;
    try {
        text = readFile(path);
    } catch (error) {
        throw new SecretPolicyError([
            `SECRET_POLICY_FILE ${path} cannot be read: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
        ]);
    }
    const { policy, templates } = readSecretPolicyFile({
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
    if (templates.tenant)
        logger.log(
            `Placeholders in tenant folders may name only: ${templates.tenant.join(", ") || "(none)"}`,
        );
    const references = new SecretReferences(
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
    return { references, templates };
}

@Module({
    providers: [
        {
            provide: SECRET_SETTINGS,
            inject: [ConfigService],
            useFactory: (config: ConfigService) => loadSecretSettings(config),
        },
        {
            provide: SECRET_REFERENCES,
            inject: [SECRET_SETTINGS],
            useFactory: (settings: SecretSettings) => settings.references,
        },
        {
            provide: CONFIG_TEMPLATE_POLICY,
            inject: [SECRET_SETTINGS],
            useFactory: (settings: SecretSettings) => settings.templates,
        },
    ],
    exports: [SECRET_REFERENCES, CONFIG_TEMPLATE_POLICY],
})
export class SecretsModule {}
