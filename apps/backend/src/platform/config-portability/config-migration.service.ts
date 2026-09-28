import {
    isConfigDocument,
    migrateDocument,
    normalizeDocument,
    resourceId,
    schemaUrl,
} from "@eudiplo/config-format/config-format.js";
import { validateConfigDocument } from "@eudiplo/config-format/config-validator.js";
import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigResourceRegistry } from "./config-resource.registry.js";
import type {
    ConfigDocument,
    ConfigFile,
    ConfigMigrationResult,
    ConfigResourceKind,
} from "./config-resource.types.js";

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

    detectLegacyVersion(_kind: ConfigResourceKind, _spec: Spec): number {
        return 1;
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
        try {
            return migrateDocument(input, validateConfigDocument);
        } catch (error) {
            throw new BadRequestException(String(error));
        }
    }

    unwrapForLegacyImporter(document: ConfigDocument): Record<string, unknown> {
        const spec = structuredClone(document.spec) as Spec;
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
