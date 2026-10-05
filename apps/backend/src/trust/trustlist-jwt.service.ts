import { Injectable, Logger } from "@nestjs/common";
import { importJWK, importX509, jwtVerify } from "jose";
import { TrustListRef } from "../verifier/presentations/entities/presentation-config.entity.js";
import { TrustFetchService } from "./trust-fetch.service.js";

/** Upper bound for a trust list JWT. */
const TRUST_LIST_MAX_BYTES = 10 * 1024 * 1024;

@Injectable()
export class TrustListJwtService {
    private readonly logger = new Logger(TrustListJwtService.name);

    constructor(private readonly trustFetch: TrustFetchService) {}

    async fetchJwt(url: string, timeoutMs = 4000): Promise<string> {
        try {
            const response = await this.trustFetch.get(url, {
                timeoutMs,
                maxBytes: TRUST_LIST_MAX_BYTES,
            });
            return response.body;
        } catch (error: any) {
            throw new Error(
                `Failed to fetch trust list from ${url}: ${error?.message || error}`,
            );
        }
    }

    private derToPemCertificate(derBase64: string): string {
        const der = Buffer.from(derBase64, "base64");
        const body =
            der
                .toString("base64")
                .match(/.{1,64}/g)
                ?.join("\n") || "";
        return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
    }

    /**
     * Verify the JWT signature/authenticity using configured verification material.
     * Exactly one secure verifier must be configured per trust list reference:
     * - verifierKey (JWK), or
     * - verifierX509Der (base64 DER X.509 certificate)
     */
    async verifyTrustListJwt(ref: TrustListRef, jwt: string): Promise<void> {
        if (!ref.verifierKey && !ref.verifierX509Der) {
            throw new Error(
                `Trust list JWT verification material missing for ${ref.url}: configure verifierKey or verifierX509Der`,
            );
        }

        try {
            const alg = ref.verifierKey?.alg || "ES256";
            const publicKey = ref.verifierKey
                ? await importJWK(ref.verifierKey, alg)
                : await importX509(
                      this.derToPemCertificate(ref.verifierX509Der!),
                      alg,
                  );

            await jwtVerify(jwt, publicKey, {
                // Allow some clock skew (5 minutes)
                clockTolerance: 300,
            });

            this.logger.debug(
                `Successfully verified trust list JWT signature for ${ref.url}`,
            );
        } catch (error: any) {
            const message = error?.message || "Unknown verification error";
            throw new Error(
                `Trust list JWT verification failed for ${ref.url}: ${message}`,
            );
        }
    }
}
