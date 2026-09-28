import { Injectable, Logger } from "@nestjs/common";
import type { Jwk } from "@openid4vc/oauth2";
import {
    CoseKey,
    DeviceKey,
    Issuer,
    SignatureAlgorithm,
    StatusOptions,
} from "@owf/mdoc";
import { X509Certificate } from "@peculiar/x509";
import { exportJWK, importX509 } from "jose";
import { CertService } from "../../../../../crypto/key/cert/cert.service.js";
import { KeyChainService } from "../../../../../crypto/key/key-chain.service.js";
import { KeyUsageType } from "../../../../../crypto/key/types/key-usage-type.js";
import type { SessionData as Session } from "../../../../../session/domain/session-data.js";
import { mdocContext } from "../../../../../verifier/presentations/mdoc-context.js";
import { StatusListService } from "../../../../status-list/status-list.service.js";
import { CredentialConfig } from "../../entities/credential.entity.js";
import { buildClaimsByNamespace } from "../../utils/index.js";
import { roundedCredentialValidity } from "../credential-time.util.js";

export interface MdocIssueOptions {
    credentialConfiguration: CredentialConfig;
    deviceKey: Jwk;
    session: Session;
    claims: Record<string, any>;
    issuanceSetId?: string;
}

/**
 * Service for issuing mDOC credentials following ISO 18013-5.
 */
@Injectable()
export class MdocIssuerService {
    private readonly logger = new Logger(MdocIssuerService.name);

    constructor(
        private readonly certService: CertService,
        private readonly keyChainService: KeyChainService,
        private readonly statusListService: StatusListService,
    ) {}

    /**
     * Issues an mDOC credential.
     * @param options - The issuance options
     * @returns The issued mDOC credential as base64url encoded string for OID4VCI
     */
    async issue(options: MdocIssueOptions): Promise<string> {
        const {
            credentialConfiguration,
            deviceKey,
            session,
            claims,
            issuanceSetId,
        } = options;

        // Get the docType from the credential configuration
        // Support both docType (camelCase) and doctype (lowercase per OID4VCI spec)
        // Default to mDL if not specified
        const docType =
            credentialConfiguration.config.docType ||
            (credentialConfiguration.config as any).doctype ||
            "org.iso.18013.5.1.mDL";

        const issuer = new Issuer(docType, mdocContext);

        const defaultNamespace = this.getDefaultNamespace(docType);
        this.addClaimsToIssuer(
            issuer,
            credentialConfiguration.fields as any,
            defaultNamespace,
            claims,
        );

        // Get signing certificate
        const certificate = await this.certService.find({
            tenantId: session.tenantId,
            type: KeyUsageType.Attestation,
            keyId: credentialConfiguration.keyChainId,
        });

        // Get the private key for signing via KeyChainEntity
        const keyChain = await this.keyChainService.getEntity(
            session.tenantId,
            certificate.keyId,
        );
        const privateKey = await exportJWK(
            await crypto.subtle.importKey(
                "jwk",
                keyChain.activeJwk,
                { name: "ECDSA", namedCurve: "P-256" },
                true,
                ["sign"],
            ),
        );

        // Convert all certificates in the chain to Uint8Array
        // certificate.crt is an array: [leaf, intermediate..., root]
        const certificateChain = certificate.crt.map((certPem) => {
            const x509Cert = new X509Certificate(certPem);
            return new Uint8Array(x509Cert.rawData);
        });

        // Diagnostic: log the leaf cert that will be embedded in the mDOC.
        try {
            const leaf = new X509Certificate(certificate.crt[0]);
            const thumb = Buffer.from(
                await crypto.subtle.digest("SHA-256", leaf.rawData),
            )
                .toString("hex")
                .toUpperCase()
                .replace(/(.{2})/g, "$1:")
                .slice(0, -1);
            this.logger.log(
                `mDOC issuance: tenant=${session.tenantId} keyChainId=${certificate.keyId} leaf.subject="${leaf.subject}" thumbprint=${thumb}`,
            );
        } catch {
            // ignore diagnostic failures
        }

        // Ensure the private key used for signing matches the embedded leaf certificate.
        await this.assertSigningKeyMatchesLeafCertificate(
            privateKey as Jwk,
            certificate.crt[0],
        );

        // Set validity dates
        // Use lifeTime from config or default to 1 year
        const { issuedAt, expiresAt } = roundedCredentialValidity(
            credentialConfiguration.lifeTime ?? 365 * 24 * 60 * 60,
        );
        const signed = new Date(issuedAt * 1000);
        const validFrom = new Date(signed);
        const validUntil = new Date(expiresAt * 1000);

        // If status management is enabled, create an entry and map it to mDOC status format.
        let status: StatusOptions | undefined;
        if (credentialConfiguration.statusManagement) {
            const statusPayload = await this.statusListService.createEntry(
                session,
                credentialConfiguration.id,
                credentialConfiguration,
                issuanceSetId,
            );
            const statusList = statusPayload.status?.status_list;
            if (statusList) {
                status = {
                    statusList: {
                        idx: statusList.idx,
                        uri: statusList.uri,
                    },
                };
            }
        }

        // Sign the mDOC
        const issuerSigned = await issuer.sign({
            signingKey: CoseKey.fromJwk(privateKey as Jwk),
            certificates: certificateChain,
            algorithm: SignatureAlgorithm.ES256,
            digestAlgorithm: "SHA-256",
            deviceKeyInfo: { deviceKey: DeviceKey.fromJwk(deviceKey) },
            validityInfo: { signed, validFrom, validUntil },
            status,
        });

        this.logger.debug(
            `Issued mDOC credential for docType: ${docType}, tenant: ${session.tenantId}`,
        );

        // Return the encoded credential for OID4VCI
        return issuerSigned.encodedForOid4Vci;
    }

    private async assertSigningKeyMatchesLeafCertificate(
        privateJwk: Jwk,
        leafCertificatePem?: string,
    ): Promise<void> {
        if (!leafCertificatePem) {
            throw new Error(
                "mDOC issuance failed: no leaf certificate configured on the selected attestation key chain",
            );
        }

        const certPublicKey = await importX509(leafCertificatePem, "ES256", {
            extractable: true,
        });
        const certPublicJwk = (await exportJWK(certPublicKey)) as Jwk;

        const privateJwkPublicPart = {
            kty: privateJwk.kty,
            crv: privateJwk.crv,
            x: privateJwk.x,
            y: privateJwk.y,
        };
        const certJwkPublicPart = {
            kty: certPublicJwk.kty,
            crv: certPublicJwk.crv,
            x: certPublicJwk.x,
            y: certPublicJwk.y,
        };

        if (
            privateJwkPublicPart.kty !== certJwkPublicPart.kty ||
            privateJwkPublicPart.crv !== certJwkPublicPart.crv ||
            privateJwkPublicPart.x !== certJwkPublicPart.x ||
            privateJwkPublicPart.y !== certJwkPublicPart.y
        ) {
            this.logger.error(
                "mDOC issuance key mismatch: active signing key does not match leaf certificate public key",
            );
            throw new Error(
                "mDOC issuance failed: signing key does not match the embedded attestation certificate. Regenerate or re-import the certificate for this key chain.",
            );
        }
    }

    /**
     * Get the default namespace for a given docType.
     */
    private getDefaultNamespace(docType: string): string {
        // For mDL, the namespace is typically "org.iso.18013.5.1"
        if (docType === "org.iso.18013.5.1.mDL") {
            return "org.iso.18013.5.1";
        }
        // For other docTypes, use the docType as namespace
        return docType;
    }

    private addClaimsToIssuer(
        issuer: Issuer,
        fields: any,
        defaultNamespace: string,
        claims: Record<string, any>,
    ): void {
        const claimsByNamespace = buildClaimsByNamespace(fields);
        const namespaceNames = new Set(Object.keys(claimsByNamespace));
        const defaultNamespaceClaims =
            claims && typeof claims === "object" && !Array.isArray(claims)
                ? Object.fromEntries(
                      Object.entries(claims).filter(
                          ([key]) => !namespaceNames.has(key),
                      ),
                  )
                : {};

        // Merge claims per namespace first, then add each namespace once.
        // This avoids duplicate issuer-signed items when fallback claims map
        // to the same default namespace already populated from field defaults.
        const mergedClaimsByNamespace: Record<
            string,
            Record<string, unknown>
        > = {};

        for (const [ns, nsClaims] of Object.entries(claimsByNamespace)) {
            mergedClaimsByNamespace[ns] = {
                ...nsClaims,
            };
        }

        if (Object.keys(defaultNamespaceClaims).length > 0) {
            const existingDefaultNamespaceClaims =
                mergedClaimsByNamespace[defaultNamespace] ?? {};
            mergedClaimsByNamespace[defaultNamespace] = {
                ...existingDefaultNamespaceClaims,
                ...defaultNamespaceClaims,
            };
        }

        for (const [ns, nsClaims] of Object.entries(mergedClaimsByNamespace)) {
            if (Object.keys(nsClaims).length === 0) {
                continue;
            }
            issuer.addIssuerNamespace(ns, nsClaims);
        }
    }
}
