import {
    CONFIG_FORMATS,
    schemaUrl,
} from "@eudiplo/config-format/config-format.js";
import { Injectable } from "@nestjs/common";
import { KMS_SECRET_PATHS } from "../../crypto/key/schemas/kms-config.schema.js";
import type { ConfigResourceKind } from "./config-resource.types.js";

export interface ConfigResourceDefinition {
    kind: ConfigResourceKind;
    slug: string;
    currentVersion: number;
    importPhase: number;
    dependsOn: ConfigResourceKind[];
    legacyFolders: string[];
    bundlePath?: string;
    singletonId?: string;
    sensitivePaths: string[];
}

const DEFINITIONS: Omit<ConfigResourceDefinition, "slug" | "currentVersion">[] =
    [
        {
            kind: "Tenant",
            importPhase: 0,
            dependsOn: [],
            legacyFolders: ["info.json"],
            bundlePath: "info.json",
            singletonId: "tenant",
            sensitivePaths: [],
        },
        {
            kind: "Client",
            importPhase: 30,
            dependsOn: ["Tenant"],
            legacyFolders: ["clients"],
            sensitivePaths: ["secret"],
        },
        {
            kind: "KmsConfig",
            importPhase: 10,
            dependsOn: ["Tenant"],
            legacyFolders: ["kms.json"],
            bundlePath: "kms.json",
            singletonId: "kms",
            sensitivePaths: [...KMS_SECRET_PATHS],
        },
        {
            kind: "KeyChain",
            importPhase: 20,
            dependsOn: ["Tenant", "KmsConfig"],
            legacyFolders: ["key-chains"],
            sensitivePaths: ["keySource.jwk"],
        },
        {
            kind: "RegistrarConfig",
            importPhase: 40,
            dependsOn: ["Tenant", "KeyChain"],
            legacyFolders: ["registrar.json"],
            bundlePath: "registrar.json",
            singletonId: "registrar",
            sensitivePaths: ["clientSecret", "password"],
        },
        {
            kind: "IssuanceConfig",
            importPhase: 70,
            dependsOn: [
                "Tenant",
                "KeyChain",
                "AttributeProvider",
                "WebhookEndpoint",
            ],
            legacyFolders: ["issuance"],
            bundlePath: "issuance/config.json",
            singletonId: "issuance",
            sensitivePaths: ["authorizationServers.*.upstream.clientSecret"],
        },
        {
            kind: "CredentialConfig",
            importPhase: 80,
            dependsOn: [
                "Tenant",
                "KeyChain",
                "AttributeProvider",
                "WebhookEndpoint",
            ],
            legacyFolders: ["issuance/credentials"],
            sensitivePaths: [],
        },
        {
            kind: "PresentationConfig",
            importPhase: 100,
            dependsOn: ["Tenant", "KeyChain", "WebhookEndpoint", "TrustList"],
            legacyFolders: ["presentation"],
            sensitivePaths: [],
        },
        {
            kind: "AttributeProvider",
            importPhase: 50,
            dependsOn: ["Tenant"],
            legacyFolders: ["attribute-providers"],
            sensitivePaths: ["auth.config.value"],
        },
        {
            kind: "WebhookEndpoint",
            importPhase: 60,
            dependsOn: ["Tenant"],
            legacyFolders: ["webhook-endpoints"],
            sensitivePaths: ["auth.config.value"],
        },
        {
            kind: "TrustList",
            importPhase: 90,
            dependsOn: ["Tenant", "KeyChain"],
            legacyFolders: ["trust-lists"],
            sensitivePaths: [],
        },
        {
            kind: "StatusList",
            importPhase: 110,
            dependsOn: ["Tenant", "KeyChain", "CredentialConfig"],
            legacyFolders: ["issuance/status-lists"],
            sensitivePaths: [],
        },
    ];

@Injectable()
export class ConfigResourceRegistry {
    private readonly byKind = new Map(
        DEFINITIONS.map((definition) => [definition.kind, definition]),
    );

    list(): readonly ConfigResourceDefinition[] {
        return DEFINITIONS.map((definition) => this.get(definition.kind));
    }

    get(kind: ConfigResourceKind): ConfigResourceDefinition {
        const definition = this.byKind.get(kind);
        if (!definition) {
            throw new Error(`Unsupported configuration resource kind: ${kind}`);
        }
        return {
            ...definition,
            slug: CONFIG_FORMATS[kind].slug,
            currentVersion: CONFIG_FORMATS[kind].version,
        };
    }

    schemaUrl(kind: ConfigResourceKind, version?: number): string {
        return schemaUrl(kind, version);
    }

    inferKind(resourceType: string): ConfigResourceKind | undefined {
        const normalized = resourceType.toLowerCase().replaceAll(/[^a-z]/g, "");
        return DEFINITIONS.find((definition) => {
            const kind = definition.kind.toLowerCase();
            const slug = CONFIG_FORMATS[definition.kind].slug.replaceAll(
                "-",
                "",
            );
            return (
                normalized === kind ||
                normalized === slug ||
                normalized === `${slug}s` ||
                normalized === `${slug}config`
            );
        })?.kind;
    }
}
