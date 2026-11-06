import { Injectable, Logger } from "@nestjs/common";
import * as x509 from "@peculiar/x509";
import {
    getRevocationCert,
    TrustedEntity,
    walletAttestationSignerServiceTypes,
} from "./types.js";

type X5cInput = string[]; // base64 DER entries

/**
 * Service type filter of {@link X509ValidationService.pathMatchesTrustedEntities}:
 * a suffix (e.g. "/Issuance" matches PID/Issuance and EAA/Issuance) or a list
 * of service types matched exactly.
 */
export type ServiceTypeFilter = `/${string}` | readonly string[];

/** Whether a trust-list service has the requested type. */
function serviceMatchesFilter(
    serviceTypeIdentifier: string,
    serviceTypeFilter: ServiceTypeFilter,
): boolean {
    return typeof serviceTypeFilter === "string"
        ? serviceTypeIdentifier.endsWith(serviceTypeFilter)
        : serviceTypeFilter.includes(serviceTypeIdentifier);
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * Parse a certificate from a Base64-encoded DER string (as used in LoTE trust lists).
 * Converts to PEM format which is more reliably parsed by @peculiar/x509.
 */
function certFromBase64Der(val: string): x509.X509Certificate {
    // Convert to PEM format - this is more reliably parsed
    const pem =
        "-----BEGIN CERTIFICATE-----\n" +
        val.match(/.{1,64}/g)!.join("\n") +
        "\n-----END CERTIFICATE-----";
    return new x509.X509Certificate(pem);
}

/**
 * Information about a matched TrustedEntity from certificate chain validation.
 * Includes the matched issuance certificate and the associated revocation certificate
 * from the same entity.
 */
export type MatchedTrustedEntity = {
    /** The TrustedEntity that was matched */
    entity: TrustedEntity;
    /** The matched issuance certificate from this entity */
    issuanceCert: x509.X509Certificate;
    /** Thumbprint of the issuance certificate */
    issuanceThumbprint: string;
    /** Whether the issuance certificate is a CA certificate */
    issuanceIsCa: boolean;
    /** The service type the issuance certificate is listed with */
    issuanceServiceType: string;
    /** The mode that matched (ca, leaf-pinned, pathEnd-pinned) */
    matchMode: "ca" | "leaf-pinned" | "pathEnd-pinned";
    /** Thumbprint of the revocation certificate (if available) */
    revocationThumbprint?: string;
};

@Injectable()
export class X509ValidationService {
    private readonly logger = new Logger(X509ValidationService.name);

    parseX5c(x5c: X5cInput): x509.X509Certificate[] {
        return x5c.map((b64) => new x509.X509Certificate(b64));
    }

    parseTrustAnchors(
        values: Array<{ certValue: string }>,
    ): x509.X509Certificate[] {
        const certs: x509.X509Certificate[] = [];
        for (const { certValue } of values) {
            try {
                const cert = certFromBase64Der(certValue);
                this.logger.debug(
                    `Parsed trust anchor: subject="${cert.subject}", issuer="${cert.issuer}"`,
                );
                certs.push(cert);
            } catch (e: any) {
                // More detailed error logging
                const cleanedVal = certValue.replace(/[\s\r\n]/g, "");
                const der = Buffer.from(cleanedVal, "base64");
                this.logger.warn(
                    `Failed to parse trust anchor certificate: ${e?.message ?? e}. ` +
                        `certValue length: ${certValue.length}, cleaned length: ${cleanedVal.length}, ` +
                        `DER buffer size: ${der.length} bytes. ` +
                        `certValue starts with: ${cleanedVal.substring(0, 50)}...`,
                );
            }
        }
        return certs;
    }

    /**
     * The certificates of all trust-list services, as input for
     * {@link parseTrustAnchors}, with those of services matching
     * `serviceTypeFilter` first.
     *
     * The chain builder takes the first certificate whose subject matches
     * the issuer and whose key verifies the signature. Two anchors can share
     * both, for example when two key chains are imported with the same
     * private key and each gets its own self-signed root. Without an order,
     * the path could then end at the issuance anchor while a status list is
     * checked against the revocation anchor, and the match fails although
     * the revocation anchor signed the certificate. Listing the requested
     * service type first makes the path end at an anchor of that type.
     */
    anchorCertValuesFor(
        entities: TrustedEntity[],
        serviceTypeFilter: ServiceTypeFilter,
    ): Array<{ certValue: string }> {
        const preferred: Array<{ certValue: string }> = [];
        const others: Array<{ certValue: string }> = [];
        for (const entity of entities) {
            for (const svc of entity.services) {
                (serviceMatchesFilter(
                    svc.serviceTypeIdentifier,
                    serviceTypeFilter,
                )
                    ? preferred
                    : others
                ).push({ certValue: svc.certValue });
            }
        }
        return [...preferred, ...others];
    }

    /**
     * Build a validated path from leaf using provided chain + anchors.
     * Returns path leaf..anchor if successful.
     */
    async buildPath(
        leaf: x509.X509Certificate,
        presentedChain: x509.X509Certificate[],
        anchors: x509.X509Certificate[],
        extraIntermediates: x509.X509Certificate[] = [],
    ): Promise<x509.X509Certificate[]> {
        const pool = [...presentedChain, ...extraIntermediates, ...anchors];
        const builder = new x509.X509ChainBuilder({ certificates: pool });
        return await builder.build(leaf);
    }

    /**
     * Determine whether anchor is a CA cert (basicConstraints CA=TRUE).
     */
    isCaCert(cert: x509.X509Certificate): boolean {
        // @peculiar/x509 provides basicConstraints extension parsing
        const bc = cert.getExtension("2.5.29.19"); // BasicConstraints
        // If missing, treat as not CA
        if (!bc) return false;
        // Peculiar returns parsed extension object with "ca" boolean for BasicConstraints
        return Boolean((bc as any).ca);
    }

    /**
     * Basic time validity check (you may rely on chain builder already doing this,
     * but keeping it explicit is sometimes useful).
     */
    isTimeValid(cert: x509.X509Certificate, now = new Date()): boolean {
        return cert.notBefore <= now && now <= cert.notAfter;
    }

    /**
     * Match the `x5c` chain of a wallet or key attestation against
     * wallet-provider entities: the path must end at a certificate listed as
     * a service that signs attestations
     * ({@link walletAttestationSignerServiceTypes}), not at one that only
     * signs status lists. Those certificates are tried first as anchors, so
     * the path ends there when an issuance and a revocation anchor share
     * subject and key.
     * @throws if no certificate path to a listed certificate can be built
     */
    async matchAttestationSigner(
        x5c: X5cInput,
        entities: TrustedEntity[],
    ): Promise<MatchedTrustedEntity | null> {
        const chain = this.parseX5c(x5c);
        const anchors = this.parseTrustAnchors(
            this.anchorCertValuesFor(
                entities,
                walletAttestationSignerServiceTypes,
            ),
        );
        const path = await this.buildPath(chain[0], chain, anchors);
        return this.pathMatchesTrustedEntities(
            path,
            entities,
            "leaf",
            walletAttestationSignerServiceTypes,
        );
    }

    /**
     * Match a certificate chain against TrustedEntities.
     * Returns the matched entity with its issuance and revocation certificates.
     *
     * Policy:
     * - Looks for certificates matching the specified service type in each entity
     * - If cert is CA: require path terminates in that anchor
     * - If cert is not CA: treat as pin
     *   - pinnedMode "leaf": leaf equals pinned cert
     *   - pinnedMode "pathEnd": path end equals pinned cert
     *
     * @param serviceTypeFilter The service types to match, see {@link ServiceTypeFilter}.
     *                          Defaults to "/Issuance" to match every issuance service.
     * @returns The matched entity info, or null if no match
     */
    async pathMatchesTrustedEntities(
        path: x509.X509Certificate[],
        entities: TrustedEntity[],
        pinnedMode: "leaf" | "pathEnd" = "leaf",
        serviceTypeFilter: ServiceTypeFilter = "/Issuance",
    ): Promise<MatchedTrustedEntity | null> {
        const leaf = path[0];
        const end = path.at(-1)!;
        const leafThumb = arrayBufferToHex(await leaf.getThumbprint("SHA-256"));
        const endThumb = arrayBufferToHex(await end.getThumbprint("SHA-256"));

        for (const entity of entities) {
            // Find certificates matching the specified service type in this entity
            const matchingServices = entity.services.filter((s) =>
                serviceMatchesFilter(
                    s.serviceTypeIdentifier,
                    serviceTypeFilter,
                ),
            );

            for (const svc of matchingServices) {
                const matchCert = certFromBase64Der(svc.certValue);
                const matchThumb = arrayBufferToHex(
                    await matchCert.getThumbprint("SHA-256"),
                );
                const matchIsCa = this.isCaCert(matchCert);

                let matchMode: "ca" | "leaf-pinned" | "pathEnd-pinned" | null =
                    null;

                if (matchIsCa) {
                    // CA cert: path must terminate at this anchor
                    if (matchThumb === endThumb) {
                        matchMode = "ca";
                    }
                } else if (pinnedMode === "leaf" && matchThumb === leafThumb) {
                    // Pinned cert (non-CA) - leaf mode
                    matchMode = "leaf-pinned";
                } else if (
                    pinnedMode === "pathEnd" &&
                    matchThumb === endThumb
                ) {
                    // Pinned cert (non-CA) - pathEnd mode
                    matchMode = "pathEnd-pinned";
                }

                if (matchMode) {
                    // Found a match! Now get the revocation cert from the same entity
                    const revocationSvc = getRevocationCert(
                        entity,
                        svc.serviceTypeIdentifier,
                    );
                    const revocationThumbprint = revocationSvc
                        ? arrayBufferToHex(
                              await certFromBase64Der(
                                  revocationSvc.certValue,
                              ).getThumbprint("SHA-256"),
                          )
                        : undefined;

                    return {
                        entity,
                        issuanceCert: matchCert,
                        issuanceThumbprint: matchThumb,
                        issuanceIsCa: matchIsCa,
                        issuanceServiceType: svc.serviceTypeIdentifier,
                        matchMode,
                        revocationThumbprint,
                    };
                }
            }
        }

        return null;
    }
}
