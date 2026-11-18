import { Injectable } from "@nestjs/common";
import type { ConfigResourceKind } from "./config-resource.types.js";

export interface ConfigResourceRouteMatch {
    kind: ConfigResourceKind;
    id: string;
    create: boolean;
    tenantId?: string;
    /**
     * The route also reaches a resource of another tenant when the caller
     * holds `tenants:manage`; the resource's own tenant then applies.
     */
    crossTenant?: boolean;
}

@Injectable()
export class ConfigResourceRouteService {
    match(
        method: string,
        path: string,
        body?: Record<string, unknown>,
    ): ConfigResourceRouteMatch | undefined {
        if (path.includes("/config-bundles")) return undefined;

        const tenantItem = /\/tenant\/([^/]+)\/?$/.exec(path);
        if (tenantItem) {
            return {
                kind: "Tenant",
                id: "tenant",
                create: false,
                tenantId: tenantItem[1],
            };
        }
        if (/\/tenant\/?$/.test(path) && body?.id) {
            return {
                kind: "Tenant",
                id: "tenant",
                create: true,
                tenantId: String(body.id),
            };
        }

        const singletonRoutes: Array<[RegExp, ConfigResourceKind, string]> = [
            [/\/key-chain\/providers\/config\/?$/, "KmsConfig", "kms"],
            [
                /\/key-chain\/access\/default\/?$/,
                "KeyChainDefaults",
                "defaults",
            ],
            [/\/issuer\/config\/?$/, "IssuanceConfig", "issuance"],
            [/\/session-config\/?$/, "Tenant", "tenant"],
            [/\/status-list-config\/?$/, "Tenant", "tenant"],
        ];
        for (const [pattern, kind, id] of singletonRoutes) {
            if (pattern.test(path))
                return { kind, id, create: method === "POST" };
        }

        const rotateSecret = /\/client\/([^/]+)\/rotate-secret\/?$/.exec(path);
        if (rotateSecret) {
            return {
                kind: "Client",
                id: rotateSecret[1],
                create: false,
                crossTenant: true,
            };
        }

        const itemRoutes: Array<[RegExp, ConfigResourceKind]> = [
            [/\/client\/([^/]+)\/?$/, "Client"],
            [/\/issuer\/credentials\/([^/]+)\/?$/, "CredentialConfig"],
            [/\/verifier\/config\/([^/]+)\/?$/, "PresentationConfig"],
            [/\/issuer\/attribute-providers\/([^/]+)\/?$/, "AttributeProvider"],
            [/\/issuer\/webhook-endpoints\/([^/]+)\/?$/, "WebhookEndpoint"],
            [/\/key-chain\/(?!import\/?$)([^/]+)\/?$/, "KeyChain"],
            [/\/trust-list\/([^/]+)\/?$/, "TrustList"],
            [/\/federation-trust-anchor\/([^/]+)\/?$/, "FederationTrustAnchor"],
            [/\/status-lists\/([^/]+)\/?$/, "StatusList"],
        ];
        for (const [pattern, kind] of itemRoutes) {
            const result = pattern.exec(path);
            if (result) return { kind, id: result[1], create: false };
        }

        const collectionRoutes: Array<
            [RegExp, ConfigResourceKind, "id" | "clientId"]
        > = [
            [/\/client\/?$/, "Client", "clientId"],
            [/\/issuer\/credentials\/?$/, "CredentialConfig", "id"],
            [/\/verifier\/config\/?$/, "PresentationConfig", "id"],
            [/\/issuer\/attribute-providers\/?$/, "AttributeProvider", "id"],
            [/\/issuer\/webhook-endpoints\/?$/, "WebhookEndpoint", "id"],
            [/\/key-chain(?:\/import)?\/?$/, "KeyChain", "id"],
            [/\/trust-list\/?$/, "TrustList", "id"],
            [/\/federation-trust-anchor\/?$/, "FederationTrustAnchor", "id"],
            [/\/status-lists\/?$/, "StatusList", "id"],
        ];
        for (const [pattern, kind, idField] of collectionRoutes) {
            const id = body?.[idField];
            if (pattern.test(path) && id) {
                return { kind, id: String(id), create: true };
            }
        }
        return undefined;
    }
}
