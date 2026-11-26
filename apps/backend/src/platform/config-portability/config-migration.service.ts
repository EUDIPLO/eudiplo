import {
    bareFileVersion,
    isConfigDocument,
    migrateDocument,
    normalizeDocument,
    resourceId,
    retiredConfigIssue,
    schemaUrl,
} from "@eudiplo/config-format/config-format.js";
import {
    validateConfigDocument,
    validateConfigFile,
} from "@eudiplo/config-format/config-validator.js";
import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigResourceRegistry } from "./config-resource.registry.js";
import type {
    ConfigDocument,
    ConfigFile,
    ConfigMigrationResult,
    ConfigResourceKind,
} from "./config-resource.types.js";
import { withoutNullRotationValues } from "./key-chain-document.js";

type Spec = Record<string, any>;
@Injectable()
export class ConfigMigrationService {
    constructor(private readonly registry: ConfigResourceRegistry) {}

    isDocument(input: unknown): input is ConfigFile {
        return isConfigDocument(input);
    }

    normalize(input: unknown): ConfigDocument {
        try {
            return normalizeDocument(input);
        } catch (error) {
            throw new BadRequestException(String(error));
        }
    }

    detectLegacyVersion(kind: ConfigResourceKind, spec: Spec): number {
        return bareFileVersion(kind, spec);
    }

    wrapLegacy(
        kind: ConfigResourceKind,
        spec: Spec,
        id?: string,
    ): ConfigDocument {
        const definition = this.registry.get(kind);
        const version = this.detectLegacyVersion(kind, spec);
        const resourceId =
            id ??
            String(
                spec.id ?? spec.clientId ?? definition.singletonId ?? "unknown",
            );
        if (kind === "KeyChain" && spec.key && !spec.keySource) {
            spec = {
                ...spec,
                keySource: { type: "private-jwk", jwk: spec.key },
            };
            delete spec.key;
        }
        if (!this.registry.get(kind).singletonId)
            spec[kind === "Client" ? "clientId" : "id"] = resourceId;
        return {
            $schema: schemaUrl(kind, version),
            kind,
            metadata: { generation: 1 },
            spec,
        };
    }

    upgrade(input: ConfigFile): ConfigMigrationResult {
        return this.migrate(input, validateConfigDocument);
    }

    /**
     * Upgrades a document of a configuration file, such as one of a bundle
     * or of a tenant folder. The schema checks the values the file holds
     * (validateConfigFile), not their escaped form. The document is returned
     * as the file holds it.
     */
    upgradeFile(input: ConfigFile): ConfigMigrationResult {
        return this.migrate(input, validateConfigFile);
    }

    private migrate(
        input: ConfigFile,
        validate: typeof validateConfigDocument,
    ): ConfigMigrationResult {
        const retired = retiredConfigIssue(input);
        if (retired) throw new BadRequestException(retired.message);
        try {
            return migrateDocument(input, validate);
        } catch (error) {
            throw new BadRequestException(String(error));
        }
    }

    unwrapForLegacyImporter(document: ConfigDocument): Record<string, unknown> {
        let spec = structuredClone(document.spec) as Spec;
        if (document.kind === "KeyChain")
            spec = withoutNullRotationValues(spec);
        if (
            document.kind === "KeyChain" &&
            spec.keySource?.type === "private-jwk"
        ) {
            spec.key = spec.keySource.jwk;
            delete spec.keySource;
        }
        if (
            spec.id === undefined &&
            document.kind !== "Client" &&
            !this.registry.get(document.kind).singletonId
        ) {
            spec.id = resourceId(document);
        }
        return spec;
    }
}
