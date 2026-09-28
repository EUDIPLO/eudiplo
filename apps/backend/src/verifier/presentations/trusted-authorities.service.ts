import { Injectable } from "@nestjs/common";
import * as x509 from "@peculiar/x509";
import { base64url } from "jose";
import { PinoLogger } from "nestjs-pino";
import { TrustListService } from "../../issuer/trust-list/trustlist.service.js";
import {
    TrustedAuthorityType,
    TrustListRef,
} from "./entities/presentation-config.entity.js";
import {
    InvalidTrustedAuthoritiesError,
    type TrustListRefResolver,
} from "./ports/trust-list-ref-resolver.js";

/**
 * Resolves the `trusted_authorities` of a presentation config: into
 * DCQL-compliant `aki` values for the wallet, and into trust-list references
 * for credential verification.
 */
@Injectable()
export class TrustedAuthoritiesService implements TrustListRefResolver {
    constructor(
        private readonly trustListService: TrustListService,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(TrustedAuthoritiesService.name);
    }

    /**
     * Transform `trusted_authorities` in a DCQL query from internal `etsi_tl`
     * format (TrustListRef objects) to the DCQL-compliant `aki` format
     * (base64url-encoded Subject Key Identifier strings).
     *
     * Per OID4VP 1.0 Final §6 / trusted-authorities-query, `aki` values must be
     * an array of strings. This ensures wallets receive a spec-compliant DCQL query
     * rather than the internal representation with TrustListRef objects.
     *
     * For each `etsi_tl` entry the Subject Key Identifier (SKI, OID 2.5.29.14)
     * of the trust anchor certificate is extracted and base64url-encoded. The
     * SKI equals the AKI field in any credential signed by that CA, so a wallet
     * can match credentials locally without fetching external resources.
     */
    async transformDcqlTrustedAuthoritiesToAki(
        dcqlQuery: any,
        tenantId: string,
    ): Promise<any> {
        const credentials = dcqlQuery?.credentials;
        if (!Array.isArray(credentials)) {
            return dcqlQuery;
        }

        const transformedCredentials = await Promise.all(
            credentials.map(async (cred: any) => {
                const trustedAuthorities = cred?.trusted_authorities;
                if (!Array.isArray(trustedAuthorities)) {
                    return cred;
                }

                const transformedAuthorities = await Promise.all(
                    trustedAuthorities.map(async (ta: any) => {
                        if (ta?.type !== TrustedAuthorityType.ETSI_TL) {
                            return ta;
                        }

                        const akiValues: string[] = [];
                        for (const ref of ta.values ?? []) {
                            const derB64 = await this.resolveTrustAnchorDer(
                                ref,
                                tenantId,
                            );
                            if (!derB64) continue;

                            const aki = extractSkiAsBase64url(derB64);
                            if (aki) {
                                akiValues.push(aki);
                            }
                        }

                        if (akiValues.length === 0) {
                            this.logger.warn(
                                { tenantId },
                                "Could not extract any AKI values from etsi_tl trusted_authorities; leaving entry unchanged",
                            );
                            return ta;
                        }

                        return { type: "aki", values: akiValues };
                    }),
                );

                return { ...cred, trusted_authorities: transformedAuthorities };
            }),
        );

        return { ...dcqlQuery, credentials: transformedCredentials };
    }

    /**
     * Resolve trust-list references for verification: managed trust lists
     * (`trustListId`) get their tenant URL and verifier certificate, external
     * ones get `<TENANT_URL>` replaced.
     *
     * @throws InvalidTrustedAuthoritiesError when a reference has neither a
     * non-empty `trustListId` nor a `url`.
     */
    async resolveTrustListRefsForTenant(
        refs: TrustListRef[] | undefined,
        tenantId: string,
        tenantHost: string,
    ): Promise<TrustListRef[]> {
        if (!Array.isArray(refs) || refs.length === 0) {
            return [];
        }

        return Promise.all(
            refs.map(async (ref) => {
                if (ref.trustListId) {
                    const trustListId = ref.trustListId.trim();
                    if (trustListId.length === 0) {
                        throw new InvalidTrustedAuthoritiesError(
                            "trusted_authorities values trustListId must not be empty",
                        );
                    }

                    const verifierX509Der =
                        await this.trustListService.getVerifierX509Der(
                            tenantId,
                            trustListId,
                        );

                    return {
                        trustListId,
                        url: `${tenantHost}/trust-list/${encodeURIComponent(trustListId)}`,
                        verifierX509Der,
                    };
                }

                const url = ref.url?.replaceAll("<TENANT_URL>", tenantHost);
                if (!url) {
                    throw new InvalidTrustedAuthoritiesError(
                        "trusted_authorities values url is required when trustListId is not set",
                    );
                }

                return {
                    ...ref,
                    url,
                    trustListId: undefined,
                };
            }),
        );
    }

    /**
     * Resolve the base64-encoded DER trust anchor certificate for a TrustListRef.
     * For managed trust lists (trustListId), fetches the verifier certificate from
     * the trust list service. For external refs, uses the supplied verifierX509Der.
     */
    private async resolveTrustAnchorDer(
        ref: TrustListRef,
        tenantId: string,
    ): Promise<string | undefined> {
        if (ref.verifierX509Der) {
            return ref.verifierX509Der;
        }
        if (ref.trustListId) {
            try {
                return await this.trustListService.getVerifierX509Der(
                    tenantId,
                    ref.trustListId,
                );
            } catch (err: any) {
                this.logger.warn(
                    { tenantId, trustListId: ref.trustListId, err },
                    "Failed to resolve verifier certificate for trust list; skipping AKI extraction",
                );
                return undefined;
            }
        }
        return undefined;
    }
}

/**
 * Extract the Subject Key Identifier (SKI, OID 2.5.29.14) from a
 * base64-encoded DER certificate and return it as a base64url string.
 *
 * Wallets check that a credential's certificate chain contains a cert whose
 * AKI matches this SKI, enabling local credential matching without fetching
 * external trust-list resources.
 */
function extractSkiAsBase64url(derB64: string): string | undefined {
    try {
        const certBytes = Buffer.from(derB64, "base64");
        const cert = new x509.X509Certificate(certBytes);
        const skiExt = cert.getExtension("2.5.29.14") as
            | { keyId?: string }
            | undefined;
        const keyId = skiExt?.keyId;
        if (!keyId) {
            return undefined;
        }
        // @peculiar/x509 returns keyId as a lowercase hex string;
        // convert to bytes and base64url-encode per OID4VP spec.
        const skiBytes = Buffer.from(keyId.replaceAll(":", ""), "hex");
        return base64url.encode(skiBytes);
    } catch {
        return undefined;
    }
}
