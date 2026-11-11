import { Injectable, Logger } from "@nestjs/common";
import * as x509 from "@peculiar/x509";
import { certificateValidityAt } from "../shared/utils/certificate-validity.util.js";
import {
    getRevocationCert,
    getStatusListSigners,
} from "./domain/status-list-signers.js";
import {
    TrustedEntity,
    TrustedEntityServiceCert,
    walletAttestationSignerServiceTypes,
} from "./types.js";

type X5cInput = string[]; // base64 DER entries

/**
 * Service type filter of {@link X509ValidationService.pathMatchesTrustedEntities}:
 * the service type identifiers to match, each compared exactly. A suffix such
 * as "/Issuance" would also match `WalletSolution/Issuance` or
 * `WRPAC/Issuance`, whose certificates sign no credentials.
 */
export type ServiceTypeFilter = readonly string[];

/** Whether a trust-list service has the requested type. */
function serviceMatchesFilter(
    serviceTypeIdentifier: string,
    serviceTypeFilter: ServiceTypeFilter,
): boolean {
    return serviceTypeFilter.includes(serviceTypeIdentifier);
}

/** How a listed certificate matched a path, see {@link X509ValidationService.pathMatchesTrustedEntities}. */
type ServiceCertMatch = {
    cert: x509.X509Certificate;
    thumbprint: string;
    isCa: boolean;
    matchMode: MatchedTrustedEntity["matchMode"];
};

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
     * Whether `now` lies in the certificate's validity period, both ends
     * included. The chain builder does not check it. The mDOC chain check in
     * `mdoc-context.ts` applies the same rule.
     */
    isTimeValid(cert: x509.X509Certificate, now = new Date()): boolean {
        return certificateValidityAt(cert, now) === "valid";
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
     * @returns The matched entity info, or null if no match
     */
    async pathMatchesTrustedEntities(
        path: x509.X509Certificate[],
        entities: TrustedEntity[],
        pinnedMode: "leaf" | "pathEnd",
        serviceTypeFilter: ServiceTypeFilter,
    ): Promise<MatchedTrustedEntity | null> {
        const { leafThumb, endThumb } = await this.pathThumbprints(path);

        for (const entity of entities) {
            // Find certificates matching the specified service type in this entity
            const matchingServices = entity.services.filter((s) =>
                serviceMatchesFilter(
                    s.serviceTypeIdentifier,
                    serviceTypeFilter,
                ),
            );

            for (const svc of matchingServices) {
                const match = await this.matchServiceCert(
                    svc,
                    leafThumb,
                    endThumb,
                    pinnedMode,
                );

                if (match) {
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
                        issuanceCert: match.cert,
                        issuanceThumbprint: match.thumbprint,
                        issuanceIsCa: match.isCa,
                        issuanceServiceType: svc.serviceTypeIdentifier,
                        matchMode: match.matchMode,
                        revocationThumbprint,
                    };
                }
            }
        }

        return null;
    }

    /**
     * The services that may sign the status list of a credential or
     * attestation matched as `matched`: the revocation services paired with
     * the matched service, or the matched certificate itself when the entity
     * lists none ({@link getStatusListSigners}).
     */
    statusListSigners(
        matched: MatchedTrustedEntity,
    ): TrustedEntityServiceCert[] {
        return getStatusListSigners(matched.entity, {
            serviceTypeIdentifier: matched.issuanceServiceType,
            certValue: Buffer.from(matched.issuanceCert.rawData).toString(
                "base64",
            ),
        });
    }

    /**
     * Whether the validated certificate path of a status list ends at one of
     * the {@link statusListSigners} of `matched`, by the rule credentials are
     * matched with: a CA certificate must be the path end, a pinned one the
     * leaf, or the path end in `pathEnd` mode. Entities are told apart by
     * certificate, not by `entityId`, which is optional and not unique.
     */
    async matchesStatusListSigner(
        path: x509.X509Certificate[],
        matched: MatchedTrustedEntity,
        pinnedMode: "leaf" | "pathEnd",
    ): Promise<boolean> {
        const { leafThumb, endThumb } = await this.pathThumbprints(path);
        for (const signer of this.statusListSigners(matched)) {
            if (
                await this.matchServiceCert(
                    signer,
                    leafThumb,
                    endThumb,
                    pinnedMode,
                )
            ) {
                return true;
            }
        }
        return false;
    }

    private async pathThumbprints(
        path: x509.X509Certificate[],
    ): Promise<{ leafThumb: string; endThumb: string }> {
        return {
            leafThumb: arrayBufferToHex(await path[0].getThumbprint("SHA-256")),
            endThumb: arrayBufferToHex(
                await path.at(-1)!.getThumbprint("SHA-256"),
            ),
        };
    }

    /**
     * How the certificate of a listed service matches a path, or null:
     * - CA certificate: the path must terminate at it
     * - not a CA: it is a pin, the leaf (pinnedMode "leaf") or the path end
     *   (pinnedMode "pathEnd") must be that certificate
     */
    private async matchServiceCert(
        svc: TrustedEntityServiceCert,
        leafThumb: string,
        endThumb: string,
        pinnedMode: "leaf" | "pathEnd",
    ): Promise<ServiceCertMatch | null> {
        const cert = certFromBase64Der(svc.certValue);
        const thumbprint = arrayBufferToHex(
            await cert.getThumbprint("SHA-256"),
        );
        const isCa = this.isCaCert(cert);

        let matchMode: ServiceCertMatch["matchMode"] | null = null;
        if (isCa) {
            if (thumbprint === endThumb) matchMode = "ca";
        } else if (pinnedMode === "leaf" && thumbprint === leafThumb) {
            matchMode = "leaf-pinned";
        } else if (pinnedMode === "pathEnd" && thumbprint === endThumb) {
            matchMode = "pathEnd-pinned";
        }

        return matchMode ? { cert, thumbprint, isCa, matchMode } : null;
    }
}
