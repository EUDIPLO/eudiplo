import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/** Fetches externally hosted issuer/schema metadata under an SSRF-safe policy. */
@Injectable()
export class MetadataFetchService {
    private readonly timeoutMs = 5000;
    private readonly maxRedirects = 3;

    constructor(private readonly configService: ConfigService) {}

    async fetch(metadataUrl: string): Promise<string | object> {
        let currentUrl = metadataUrl;

        for (
            let redirectCount = 0;
            redirectCount <= this.maxRedirects;
            redirectCount++
        ) {
            await this.assertSafeUrl(currentUrl);

            const response = await fetch(currentUrl, {
                method: "GET",
                headers: { accept: "application/json" },
                redirect: "manual",
                signal: AbortSignal.timeout(this.timeoutMs),
            }).catch((error) => {
                throw new BadRequestException(
                    `Failed to fetch issuer metadata from ${currentUrl}: ${error instanceof Error ? error.message : "unknown error"}`,
                );
            });

            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get("location");
                if (!location) {
                    throw new BadRequestException(
                        `Issuer metadata response from ${currentUrl} returned a redirect without a location header`,
                    );
                }
                currentUrl = new URL(location, currentUrl).toString();
                continue;
            }

            if (!response.ok) {
                throw new BadRequestException(
                    `Failed to fetch issuer metadata from ${currentUrl}: HTTP ${response.status}`,
                );
            }

            const text = await response.text();
            try {
                return JSON.parse(text);
            } catch {
                if (
                    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
                        text,
                    )
                ) {
                    return { signedJwt: text };
                }
                throw new BadRequestException(
                    `Issuer metadata response from ${currentUrl} is not valid JSON or JWT`,
                );
            }
        }

        throw new BadRequestException(
            `Issuer metadata fetch exceeded ${this.maxRedirects} redirects`,
        );
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

    private async assertSafeUrl(inputUrl: string): Promise<void> {
        const parsedUrl = new URL(inputUrl);
        if (parsedUrl.username || parsedUrl.password) {
            throw new BadRequestException(
                "issuerUrl must not include userinfo credentials",
            );
        }

        if (this.configService.get<string>("NODE_ENV") !== "production") {
            return;
        }

        const hostname = parsedUrl.hostname.toLowerCase();
        if (
            hostname === "localhost" ||
            hostname.endsWith(".localhost") ||
            hostname.endsWith(".local")
        ) {
            throw new BadRequestException(
                "issuerUrl must resolve to a public host",
            );
        }

        const resolvedAddresses = isIP(hostname)
            ? [hostname]
            : (
                  await lookup(hostname, { all: true, verbatim: true }).catch(
                      () => {
                          throw new BadRequestException(
                              "issuerUrl host could not be resolved",
                          );
                      },
                  )
              ).map((entry) => entry.address);

        if (
            resolvedAddresses.length === 0 ||
            resolvedAddresses.some((address) => this.isPrivateIp(address))
        ) {
            throw new BadRequestException(
                "issuerUrl must resolve to a public host",
            );
        }
    }

    private isPrivateIp(address: string): boolean {
        const normalizedAddress =
            address.startsWith("::ffff:") && isIP(address.slice(7)) === 4
                ? address.slice(7)
                : address;
        const family = isIP(normalizedAddress);

        if (family === 4) {
            const [first, second] = normalizedAddress.split(".").map(Number);
            return (
                first === 0 ||
                first === 10 ||
                first === 127 ||
                (first === 100 && second >= 64 && second <= 127) ||
                (first === 169 && second === 254) ||
                (first === 172 && second >= 16 && second <= 31) ||
                (first === 192 && second === 168) ||
                (first === 198 && (second === 18 || second === 19))
            );
        }

        if (family === 6) {
            const normalized = normalizedAddress.toLowerCase();
            return (
                normalized === "::" ||
                normalized === "::1" ||
                normalized.startsWith("fc") ||
                normalized.startsWith("fd") ||
                /^fe[89ab]/.test(normalized)
            );
        }

        return true;
    }
}
