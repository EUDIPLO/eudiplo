import { BadRequestException, Injectable } from "@nestjs/common";
import { OutboundUrlPolicyService } from "../../../webhook/outbound-url-policy.service.js";

/**
 * Fetches externally hosted issuer/schema metadata under the shared outbound
 * URL policy (`OUTBOUND_URL_*` settings). Every redirect hop is checked, and
 * the connected address is validated at connect time.
 */
@Injectable()
export class MetadataFetchService {
    private readonly timeoutMs = 5000;
    private readonly maxRedirects = 3;
    private readonly maxResponseBytes = 5 * 1024 * 1024;

    constructor(private readonly outboundUrlPolicy: OutboundUrlPolicyService) {}

    async fetch(metadataUrl: string): Promise<string | object> {
        this.assertNoUserinfo(metadataUrl);

        const response = await this.outboundUrlPolicy
            .getFollowingRedirects(metadataUrl, {
                timeoutMs: this.timeoutMs,
                maxBytes: this.maxResponseBytes,
                maxRedirects: this.maxRedirects,
                headers: { accept: "application/json" },
            })
            .catch((error) => {
                if (error instanceof BadRequestException) throw error;
                throw new BadRequestException(
                    `Failed to fetch issuer metadata from ${metadataUrl}: ${error instanceof Error ? error.message : "unknown error"}`,
                );
            });

        if (response.status < 200 || response.status >= 300) {
            throw new BadRequestException(
                `Failed to fetch issuer metadata from ${response.url}: HTTP ${response.status}`,
            );
        }

        const text = response.body;
        try {
            return JSON.parse(text);
        } catch {
            if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text)) {
                return { signedJwt: text };
            }
            throw new BadRequestException(
                `Issuer metadata response from ${response.url} is not valid JSON or JWT`,
            );
        }
    }

    buildCredentialIssuerMetadataUrl(inputUrl: string): string {
        let parsedUrl: URL;
        try {
            parsedUrl = new URL(inputUrl.trim());
        } catch {
            throw new BadRequestException("issuerUrl must be a valid URL");
        }

        if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
            throw new BadRequestException(
                "issuerUrl must use http or https protocol",
            );
        }
        if (parsedUrl.search || parsedUrl.hash) {
            throw new BadRequestException(
                "issuerUrl must not include query parameters or fragments",
            );
        }

        const wellKnownPrefix = "/.well-known/openid-credential-issuer";
        const normalizedPath = parsedUrl.pathname.replace(/\/$/, "");
        const issuerPath = normalizedPath.startsWith(wellKnownPrefix)
            ? normalizedPath.slice(wellKnownPrefix.length) || ""
            : normalizedPath;

        return `${parsedUrl.origin}${wellKnownPrefix}${issuerPath}`;
    }

    private assertNoUserinfo(inputUrl: string): void {
        let parsedUrl: URL;
        try {
            parsedUrl = new URL(inputUrl);
        } catch {
            throw new BadRequestException("issuerUrl must be a valid URL");
        }
        if (parsedUrl.username || parsedUrl.password) {
            throw new BadRequestException(
                "issuerUrl must not include userinfo credentials",
            );
        }
    }
}
