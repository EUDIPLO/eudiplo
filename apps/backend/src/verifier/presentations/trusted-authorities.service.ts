import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { TrustListService } from "../../issuer/trust-list/trustlist.service.js";
import {
    credentialIssuerAuthorityKeyIdentifiers,
    type IssuerAuthorityKeyIdentifiers,
} from "../../trust/domain/authority-key-identifiers.js";
import { TrustStoreService } from "../../trust/trust-store.service.js";
import {
    TrustedAuthorityType,
    TrustListRef,
} from "./entities/presentation-config.entity.js";
import {
    InvalidTrustedAuthoritiesError,
    type TrustListRefResolver,
} from "./ports/trust-list-ref-resolver.js";

/** A `trusted_authorities` entry as sent to the wallet. */
type WalletTrustedAuthority = { type: string; values: string[] };

/**
 * Resolves the `trusted_authorities` of a presentation config: into
 * DCQL-compliant `aki` values for the wallet, and into trust-list references
 * for credential verification.
 */
@Injectable()
export class TrustedAuthoritiesService implements TrustListRefResolver {
    constructor(
        private readonly trustListService: TrustListService,
        private readonly trustStore: TrustStoreService,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(TrustedAuthoritiesService.name);
    }

    /**
     * Transform `trusted_authorities` in a DCQL query from the internal `etsi_tl`
     * format (TrustListRef objects) into what the wallet receives: an `aki`
     * entry (OpenID4VP 1.0 §6.1.1.1) whose values are the base64url-encoded key
     * identifiers of the credential issuers listed in the referenced trust
     * lists, so the wallet can match credentials without fetching the lists.
     *
     * The values come from the PID/EAA issuance certificates of the listed
     * entities (see {@link credentialIssuerAuthorityKeyIdentifiers}), not from
     * the certificate that signs the trust list. Managed lists are read from
     * their stored content, external lists are fetched and signature-verified.
     *
     * A trust list that cannot be loaded, or whose issuers are not all covered
     * by key identifiers (e.g. a pinned self-signed certificate without AKI),
     * is logged and additionally stays an `etsi_tl` entry, reduced to its plain
     * trust-list URL as the spec requires. Entries of a credential query are
     * alternatives, so the wallet still matches the issuers that resolved.
     * Verification is unaffected: it reads the stored config.
     */
    async transformDcqlTrustedAuthoritiesToAki(
        dcqlQuery: any,
        tenantId: string,
        tenantHost: string,
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

                const transformedAuthorities = (
                    await Promise.all(
                        trustedAuthorities.map((ta: any) =>
                            ta?.type === TrustedAuthorityType.ETSI_TL
                                ? this.toWalletAuthorities(
                                      ta.values ?? [],
                                      tenantId,
                                      tenantHost,
                                  )
                                : [ta],
                        ),
                    )
                ).flat();

                // `trusted_authorities` must be non-empty when present.
                if (transformedAuthorities.length === 0) {
                    const { trusted_authorities: _, ...rest } = cred;
                    return rest;
                }
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
                        url: managedTrustListUrl(tenantHost, trustListId),
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
     * Wallet-facing entries for the trust lists of one `etsi_tl` entry: one
     * `aki` entry with the key identifiers of all lists, and an `etsi_tl` entry
     * with the URLs of the lists they do not fully cover.
     */
    private async toWalletAuthorities(
        refs: TrustListRef[],
        tenantId: string,
        tenantHost: string,
    ): Promise<WalletTrustedAuthority[]> {
        const akiValues = new Set<string>();
        const unresolvedUrls: string[] = [];
        for (const ref of refs) {
            const { values, complete } = await this.authorityKeyIdentifiers(
                ref,
                tenantId,
            );
            for (const value of values) akiValues.add(value);
            if (complete && values.length > 0) continue;

            const trustListId = ref.trustListId?.trim();
            const url = trustListId
                ? managedTrustListUrl(tenantHost, trustListId)
                : ref.url;
            if (url) unresolvedUrls.push(url);
        }

        const authorities: WalletTrustedAuthority[] = [];
        if (akiValues.size > 0) {
            authorities.push({ type: "aki", values: [...akiValues] });
        }
        if (unresolvedUrls.length > 0) {
            this.logger.warn(
                { tenantId, trustLists: unresolvedUrls },
                "AKI values do not cover all issuers of these etsi_tl trust lists; also sending the trust-list URLs",
            );
            authorities.push({
                type: TrustedAuthorityType.ETSI_TL,
                values: unresolvedUrls,
            });
        }
        return authorities;
    }

    /** Key identifiers of the credential issuers listed in one trust list. */
    private async authorityKeyIdentifiers(
        ref: TrustListRef,
        tenantId: string,
    ): Promise<IssuerAuthorityKeyIdentifiers> {
        try {
            return credentialIssuerAuthorityKeyIdentifiers(
                await this.trustStore.getListedEntities(ref, tenantId),
            );
        } catch (err: unknown) {
            this.logger.warn(
                { tenantId, trustListId: ref.trustListId, url: ref.url, err },
                "Failed to load trust list for AKI extraction",
            );
            return { values: [], complete: false };
        }
    }
}

function managedTrustListUrl(tenantHost: string, trustListId: string): string {
    return `${tenantHost}/trust-list/${encodeURIComponent(trustListId)}`;
}
