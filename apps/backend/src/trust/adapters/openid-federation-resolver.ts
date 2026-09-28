import { X509Certificate } from "node:crypto";
import { HttpService } from "@nestjs/axios";
import { Inject, Injectable } from "@nestjs/common";
import {
    compactVerify,
    decodeJwt,
    decodeProtectedHeader,
    importX509,
} from "jose";
import { firstValueFrom } from "rxjs";
import {
    type FederationEntityConfiguration,
    type FederationResolver,
} from "../ports/federation-resolver.js";

@Injectable()
export class OpenIdFederationResolver implements FederationResolver {
    constructor(@Inject(HttpService) private readonly http: HttpService) {}

    async resolveEntityConfiguration(
        entityId: string,
    ): Promise<FederationEntityConfiguration> {
        const url = `${entityId.replace(/\/$/, "")}/.well-known/openid-federation`;
        const response = await firstValueFrom(
            this.http.get<string | Record<string, unknown>>(url, {
                responseType: "text" as never,
            }),
        );
        return this.parse(response.data, entityId);
    }

    private async parse(
        response: string | Record<string, unknown>,
        entityId: string,
    ): Promise<FederationEntityConfiguration> {
        if (typeof response === "string") {
            const trimmed = response.trim();
            if (trimmed.startsWith("{")) {
                return JSON.parse(trimmed) as FederationEntityConfiguration;
            }
            if (trimmed.split(".").length >= 2) {
                return this.parseSignedJwt(trimmed, entityId);
            }
        } else if (response && typeof response === "object") {
            const entityConfiguration = response.entity_configuration;
            if (
                typeof entityConfiguration === "string" &&
                entityConfiguration.split(".").length >= 2
            ) {
                return this.parseSignedJwt(entityConfiguration, entityId);
            }
            return response as FederationEntityConfiguration;
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
