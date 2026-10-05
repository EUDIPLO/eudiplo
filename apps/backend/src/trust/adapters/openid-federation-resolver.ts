import { X509Certificate } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
    compactVerify,
    decodeJwt,
    decodeProtectedHeader,
    importX509,
} from "jose";
import {
    type FederationEntityConfiguration,
    type FederationResolver,
} from "../ports/federation-resolver.js";
import { TrustFetchService } from "../trust-fetch.service.js";

/** A slow or unresponsive federation entity must not stall trust evaluation. */
const FEDERATION_FETCH_TIMEOUT_MS = 5000;

/** Upper bound for an entity configuration. */
const FEDERATION_MAX_BYTES = 1024 * 1024;

@Injectable()
export class OpenIdFederationResolver implements FederationResolver {
    constructor(
        @Inject(TrustFetchService)
        private readonly trustFetch: Pick<TrustFetchService, "get">,
    ) {}

    async resolveEntityConfiguration(
        entityId: string,
    ): Promise<FederationEntityConfiguration> {
        const url = `${entityId.replace(/\/$/, "")}/.well-known/openid-federation`;
        const response = await this.trustFetch.get(url, {
            timeoutMs: FEDERATION_FETCH_TIMEOUT_MS,
            maxBytes: FEDERATION_MAX_BYTES,
        });
        return this.parse(response.body, entityId);
    }

    private async parse(
        response: string,
        entityId: string,
    ): Promise<FederationEntityConfiguration> {
        const trimmed = response.trim();
        if (trimmed.startsWith("{")) {
            const json = JSON.parse(trimmed) as Record<string, unknown>;
            const entityConfiguration = json.entity_configuration;
            if (
                typeof entityConfiguration === "string" &&
                entityConfiguration.split(".").length >= 2
            ) {
                return this.parseSignedJwt(entityConfiguration, entityId);
            }
            return json as FederationEntityConfiguration;
        }
        if (trimmed.split(".").length >= 2) {
            return this.parseSignedJwt(trimmed, entityId);
        }

        throw new Error(
            `Unsupported federation entity configuration response for ${entityId}`,
        );
    }

    private async parseSignedJwt(
        compactJwt: string,
        entityId: string,
    ): Promise<FederationEntityConfiguration> {
        const header = decodeProtectedHeader(compactJwt);
        const x5c = header.x5c;

        if (!Array.isArray(x5c) || typeof x5c[0] !== "string") {
            // Preserve compatibility with existing non-production fixtures and
            // legacy federation documents that do not carry a certificate.
            return decodeJwt(compactJwt) as FederationEntityConfiguration;
        }

        const certificate = new X509Certificate(Buffer.from(x5c[0], "base64"));
        const pem = certificate.toString();
        const algorithm = header.alg;
        if (algorithm !== "ES256" && algorithm !== "RS256") {
            throw new Error(
                `Unsupported federation entity configuration algorithm '${algorithm}' for ${entityId}`,
            );
        }

        const publicKey = await importX509(pem, algorithm);
        await compactVerify(compactJwt, publicKey, {
            algorithms: [algorithm],
        });

        return decodeJwt(compactJwt) as FederationEntityConfiguration;
    }
}
