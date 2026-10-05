import { Inject, Injectable } from "@nestjs/common";
import {
    type OutboundFinalResponse,
    OutboundUrlPolicyService,
} from "../webhook/outbound-url-policy.service.js";
import {
    TRUST_STORE_SETTINGS,
    type TrustStoreSettings,
} from "./trust-store-settings.js";

/** The axios client used for these fetches before followed five redirects. */
const MAX_REDIRECTS = 5;

export interface TrustFetchOptions {
    timeoutMs: number;
    maxBytes: number;
    accept?: string;
}

/**
 * Fetches trust lists, status lists and federation entity configurations
 * under the outbound URL policy. Their URLs can come from presented
 * credentials and certificates, so without the policy a wallet could make
 * EUDIPLO request internal addresses.
 *
 * EUDIPLO's own `PUBLIC_URL` and `INTERNAL_URL` are exempt: managed trust
 * lists and the status lists of credentials EUDIPLO issued are fetched from
 * there, and `INTERNAL_URL` usually is a private address.
 */
@Injectable()
export class TrustFetchService {
    private readonly ownOrigins: string[];

    constructor(
        @Inject(OutboundUrlPolicyService)
        private readonly outboundUrlPolicy: OutboundUrlPolicyService,
        @Inject(TRUST_STORE_SETTINGS) settings: TrustStoreSettings,
    ) {
        this.ownOrigins = [settings.publicUrl, settings.internalUrl].filter(
            (url): url is string => Boolean(url),
        );
    }

    /** GET a URL, following redirects; non-2xx responses are rejected. */
    async get(
        url: string,
        options: TrustFetchOptions,
    ): Promise<OutboundFinalResponse> {
        const response = await this.outboundUrlPolicy.getFollowingRedirects(
            url,
            {
                timeoutMs: options.timeoutMs,
                maxBytes: options.maxBytes,
                headers: options.accept
                    ? { accept: options.accept }
                    : undefined,
                maxRedirects: MAX_REDIRECTS,
                trustedOrigins: this.ownOrigins,
                // Unchanged from before the policy applied: TLS certificates
                // of these hosts are only verified in production.
                rejectUnauthorized: process.env.NODE_ENV === "production",
            },
        );
        if (response.status < 200 || response.status >= 300) {
            throw new Error(
                `Request failed with status code ${response.status}`,
            );
        }
        return response;
    }
}
