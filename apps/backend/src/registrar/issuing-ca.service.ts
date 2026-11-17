import { X509Certificate } from "node:crypto";
import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import { outboundFetch } from "../webhook/outbound-fetch.js";
import { OutboundUrlPolicyService } from "../webhook/outbound-url-policy.service.js";

/**
 * Limits for fetching an issuing CA: one deadline per request including
 * redirects and body, a size cap, and a few redirects, each checked against
 * the outbound URL policy.
 */
const ISSUING_CA_REQUEST_LIMITS = {
    timeoutMs: 30_000,
    maxBytes: 1024 * 1024,
    maxRedirects: 3,
};

/**
 * Completes an access certificate from a registrar with the CA that issued
 * it, as wallets need it in `x5c` to build the path to the root they trust
 * (OID4VP 1.0, section 5.9.3). Registrars such as the EUDI Hub sign with an
 * issuing CA below their root and hand out the certificate alone.
 */
@Injectable()
export class IssuingCaService {
    private readonly logger = new Logger(IssuingCaService.name);
    private readonly fetch: typeof fetch;

    constructor(
        outboundUrlPolicy: OutboundUrlPolicyService,
        http: HttpService,
    ) {
        this.fetch = outboundFetch(
            http,
            outboundUrlPolicy,
            ISSUING_CA_REQUEST_LIMITS,
        );
    }

    /**
     * The certificate followed by the CA that issued it. The CA is fetched
     * from the URL the certificate names in its Authority Information Access
     * extension (`caIssuers`), DER or PEM, under the outbound URL policy. It
     * is added only when it issued the certificate and is not self-signed: a
     * root is the trust anchor and stays out of `x5c`. When it cannot be
     * fetched, the certificate is returned alone and the log says so.
     *
     * @param registrar - Name of the registrar, for the log.
     */
    async chainFor(
        tenantId: string,
        crt: string,
        registrar: string,
    ): Promise<string[]> {
        const leaf = new X509Certificate(crt);
        const url = leaf.infoAccess
            ?.split("\n")
            .map((line) => /^CA Issuers - URI:(\S+)$/.exec(line.trim())?.[1])
            .find((value) => value !== undefined);
        if (!url) {
            this.logger.warn(
                `[${tenantId}] The ${registrar} access certificate names no issuing CA; storing it without one, so wallets need that CA as trust anchor`,
            );
            return [crt];
        }
        try {
            const issuer = await this.fetchCertificate(url);
            if (!leaf.checkIssued(issuer) || !leaf.verify(issuer.publicKey)) {
                this.logger.warn(
                    `[${tenantId}] The certificate at ${url} did not issue the ${registrar} access certificate; storing it without its issuing CA`,
                );
                return [crt];
            }
            return issuer.checkIssued(issuer)
                ? [crt]
                : [crt, issuer.toString()];
        } catch (error) {
            this.logger.warn(
                `[${tenantId}] Could not fetch the issuing CA of the ${registrar} access certificate from ${url}; storing it without one: ${error instanceof Error ? error.message : String(error)}`,
            );
            return [crt];
        }
    }

    /**
     * The certificate at a public URL. The request carries no credentials,
     * as the URL may be on any host.
     */
    private async fetchCertificate(url: string): Promise<X509Certificate> {
        const response = await this.fetch(url, { method: "GET" });
        if (!response.ok) {
            throw new Error(
                `The CA certificate at ${url} could not be fetched (HTTP ${response.status})`,
            );
        }
        try {
            return new X509Certificate(
                Buffer.from(await response.arrayBuffer()),
            );
        } catch {
            throw new Error(`${url} did not answer with a certificate`);
        }
    }
}
