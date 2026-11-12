import { Injectable, Logger } from "@nestjs/common";
import * as x509 from "@peculiar/x509";
import { assertCertificateChainLength } from "../shared/utils/certificate-chain-length.util.js";
import { CertificatePathBuilder } from "../shared/utils/certificate-path.util.js";
import { certificateValidityAt } from "../shared/utils/certificate-validity.util.js";
import { assertAttestationPathValidAt } from "./domain/attestation-certificate-validity.js";
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

    /**
     * Parse an `x5c` that a wallet or a remote host sent.
     * @throws CertificateChainTooLong, before parsing, if it holds more than
     * `MAX_CERTIFICATE_CHAIN_LENGTH` certificates
     */
    parseX5c(x5c: X5cInput): x509.X509Certificate[] {
        assertCertificateChainLength(x5c);
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
        const { preferred, others } = this.anchorCertValueGroups(
            entities,
            serviceTypeFilter,
        );
        return [...preferred, ...others];
    }

    /**
     * The certificates of all trust-list services, those of services
     * matching `serviceTypeFilter` apart from the others, each in trust-list
     * order.
     */
    private anchorCertValueGroups(
        entities: TrustedEntity[],
        serviceTypeFilter: ServiceTypeFilter,
    ): {
        preferred: Array<{ certValue: string }>;
        others: Array<{ certValue: string }>;
    } {
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
        return { preferred, others };
    }

    /** `certs` with those valid at `now` first, each part in its order. */
    private validFirst(
        certs: x509.X509Certificate[],
        now: Date,
    ): x509.X509Certificate[] {
        const valid = new Set(
            certs.filter((cert) => this.isTimeValid(cert, now)),
        );
        return [...valid, ...certs.filter((cert) => !valid.has(cert))];
    }

    /**
     * Build a validated path from leaf using provided chain + anchors.
     * Returns path leaf..anchor if successful.
     * @param presentedChain The chain a wallet or remote host sent, the
     * output of {@link parseX5c}; the only input whose length is checked
     * @throws CertificateChainTooLong if `presentedChain` holds more than
     * `MAX_CERTIFICATE_CHAIN_LENGTH` certificates
     * @throws CertificatePathLimitExceeded if the path is longer than
     * `MAX_CERTIFICATE_PATH_LENGTH` or not found within
     * `MAX_PATH_SIGNATURE_CHECKS` signature checks
     */
    async buildPath(
        leaf: x509.X509Certificate,
        presentedChain: x509.X509Certificate[],
        anchors: x509.X509Certificate[],
        extraIntermediates: x509.X509Certificate[] = [],
    ): Promise<x509.X509Certificate[]> {
        assertCertificateChainLength(presentedChain);
        const pool = [...presentedChain, ...extraIntermediates, ...anchors];
        return await new CertificatePathBuilder(pool).build(leaf);
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
     * signs status lists.
     *
     * The chain builder takes the first certificate whose subject matches
     * the issuer and whose key verifies the signature, so the order of its
     * pool decides between certificates that share subject and key:
     * 1. the listed signer certificates, those valid at `now` first. A
     *    service can list a CA and its renewal with the same subject and key;
     *    the path ends at the one still valid, whichever the list names
     *    first, also when `x5c` carries the other one;
     * 2. the presented chain;
     * 3. the other listed certificates, such as revocation CAs, in
     *    trust-list order. After the signers, so the path ends at the
     *    issuance anchor when an issuance and a revocation anchor share
     *    subject and key; after the presented chain, so they do not take the
     *    place of a presented intermediate.
     *
     * Every certificate from the signing certificate to the listed one must
     * be valid at `now`, both ends of its period included
     * ({@link assertAttestationPathValidAt}). Neither the chain builder nor
     * `jose` checks validity periods.
     * @param options.now The time to check at; default: the current time
     * @param options.ignoreValidityPeriods Leave the periods unchecked, for
     * an attestation that was checked when it was presented and whose
     * provider is matched again later
     * @throws CertificateChainTooLong if `x5c` holds more certificates than
     * `MAX_CERTIFICATE_CHAIN_LENGTH`
     * @throws CertificatePathLimitExceeded if the path is longer than
     * `MAX_CERTIFICATE_PATH_LENGTH` or not found within
     * `MAX_PATH_SIGNATURE_CHECKS` signature checks
     * @throws if no certificate path to a listed certificate can be built
     * @throws AttestationCertificateNotValid if a certificate of the matched
     * path is outside its validity period
     */
    async matchAttestationSigner(
        x5c: X5cInput,
        entities: TrustedEntity[],
        options: { now?: Date; ignoreValidityPeriods?: boolean } = {},
    ): Promise<MatchedTrustedEntity | null> {
        const now = options.now ?? new Date();
        const { preferred, others } = this.anchorCertValueGroups(
            entities,
            walletAttestationSignerServiceTypes,
        );
        const path = await this.buildAttestationPath(
            x5c,
            preferred,
            others,
            now,
        );
        const matched = await this.pathMatchesTrustedEntities(
            path,
            entities,
            "leaf",
            walletAttestationSignerServiceTypes,
        );
        if (matched && !options.ignoreValidityPeriods) {
            this.assertMatchedPathValidAt(path, matched.matchMode, now);
        }
        return matched;
    }

    /**
     * Build the certificate path of an attestation or its status list from
     * its `x5c`, with the chain builder's pool in the order that
     * {@link matchAttestationSigner} explains: the certificates the path
     * should end at (`signers`), those valid at `now` first; then the
     * presented chain; then the other listed certificates.
     * @throws CertificateChainTooLong, before parsing, if `x5c` holds more
     * certificates than `MAX_CERTIFICATE_CHAIN_LENGTH`
     * @throws CertificatePathLimitExceeded if the path is longer than
     * `MAX_CERTIFICATE_PATH_LENGTH` or not found within
     * `MAX_PATH_SIGNATURE_CHECKS` signature checks
     * @throws if no certificate path can be built
     */
    private buildAttestationPath(
        x5c: X5cInput,
        signers: Array<{ certValue: string }>,
        others: Array<{ certValue: string }>,
        now: Date,
    ): Promise<x509.X509Certificate[]> {
        const chain = this.parseX5c(x5c);
        return new CertificatePathBuilder([
            ...this.validFirst(this.parseTrustAnchors(signers), now),
            ...chain,
            ...this.parseTrustAnchors(others),
        ]).build(chain[0]);
    }

    /**
     * Check the validity periods of a path that matched a listed certificate
     * in `matchMode`: from the signing certificate up to the listed one, the
     * signing certificate itself when it is pinned
     * ({@link assertAttestationPathValidAt}).
     */
    private assertMatchedPathValidAt(
        path: x509.X509Certificate[],
        matchMode: MatchedTrustedEntity["matchMode"],
        now: Date,
    ): void {
        assertAttestationPathValidAt(
            path,
            matchMode === "leaf-pinned" ? 0 : path.length - 1,
            now,
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
        return (
            (await this.statusListSignerMatch(path, matched, pinnedMode)) !==
            null
        );
    }

    /**
     * Match the `x5c` chain of a wallet or key attestation's status list
     * against the {@link statusListSigners} of the provider the attestation
     * matched: a CA signer must be the path end, a pinned one the signing
     * certificate.
     *
     * The chain builder's pool is ordered as in
     * {@link matchAttestationSigner}: the status list signers, those valid at
     * `now` first, so that the path ends at a signer CA's valid renewal that
     * has its subject and key, whichever the list names first and also when
     * `x5c` carries the other one; then the presented chain; then the other
     * listed certificates, which therefore do not take the place of a
     * presented intermediate.
     *
     * Every certificate from the status list's signing certificate to the
     * signer it matched must be valid at `now`, both ends of its period
     * included ({@link assertAttestationPathValidAt}). Certificates above a
     * pinned signer are not part of the trust decision and are not checked,
     * also when a signer CA above it is listed as well, whatever the order
     * of the list.
     * @param x5c The status list's `x5c`, signing certificate first
     * @param matched The provider the attestation matched
     * @param entities All entities of the trust store, for path building
     * @param options.now The time to check at; default: the current time
     * @returns The path, signing certificate first, and whether it matched
     * one of the provider's status list signers
     * @throws CertificateChainTooLong if `x5c` holds more certificates than
     * `MAX_CERTIFICATE_CHAIN_LENGTH`
     * @throws CertificatePathLimitExceeded if the path is longer than
     * `MAX_CERTIFICATE_PATH_LENGTH` or not found within
     * `MAX_PATH_SIGNATURE_CHECKS` signature checks
     * @throws if no certificate path can be built
     * @throws AttestationCertificateNotValid if the path matched and a
     * certificate of it is outside its validity period
     */
    async matchAttestationStatusListSigner(
        x5c: X5cInput,
        matched: MatchedTrustedEntity,
        entities: TrustedEntity[],
        options: { now?: Date } = {},
    ): Promise<{ path: x509.X509Certificate[]; matched: boolean }> {
        const now = options.now ?? new Date();
        const path = await this.buildAttestationPath(
            x5c,
            this.statusListSigners(matched).map(({ certValue }) => ({
                certValue,
            })),
            entities.flatMap((entity) =>
                entity.services.map(({ certValue }) => ({ certValue })),
            ),
            now,
        );
        const signer = await this.statusListSignerMatch(path, matched, "leaf");
        if (signer) {
            this.assertMatchedPathValidAt(path, signer.matchMode, now);
        }
        return { path, matched: signer !== null };
    }

    /**
     * How `path` matches the {@link statusListSigners} of `matched`, or null;
     * see {@link matchesStatusListSigner}. A pinned signing certificate
     * matches before a listed CA at the path end: the pin is the narrower
     * trust decision, which {@link matchAttestationStatusListSigner} then
     * checks alone.
     */
    private async statusListSignerMatch(
        path: x509.X509Certificate[],
        matched: MatchedTrustedEntity,
        pinnedMode: "leaf" | "pathEnd",
    ): Promise<ServiceCertMatch | null> {
        const { leafThumb, endThumb } = await this.pathThumbprints(path);
        let first: ServiceCertMatch | null = null;
        for (const signer of this.statusListSigners(matched)) {
            const match = await this.matchServiceCert(
                signer,
                leafThumb,
                endThumb,
                pinnedMode,
            );
            if (match?.matchMode === "leaf-pinned") return match;
            first ??= match;
        }
        return first;
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
