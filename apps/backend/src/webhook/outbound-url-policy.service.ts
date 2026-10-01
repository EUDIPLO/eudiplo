import { type LookupAddress, lookup as lookupCallback } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/** Response of {@link OutboundUrlPolicyService.get}; redirects are not followed. */
export interface OutboundResponse {
    status: number;
    location?: string;
    contentType?: string;
    /** UTF-8 decoding of {@link bytes}. */
    body: string;
    bytes: Buffer;
}

/** Final response of {@link OutboundUrlPolicyService.getFollowingRedirects}. */
export interface OutboundFinalResponse extends OutboundResponse {
    /** URL of the last hop, which produced this response. */
    url: string;
}

interface OutboundGetOptions {
    timeoutMs: number;
    maxBytes: number;
    headers?: Record<string, string>;
}

@Injectable()
export class OutboundUrlPolicyService {
    constructor(private readonly configService: ConfigService) {}

    /**
     * `dns.lookup` replacement for outbound connections. It validates the
     * addresses that are actually connected to, so a hostname cannot pass
     * {@link assertSafeUrl} with a public address and then resolve to a private
     * one for the connection (DNS rebinding).
     */
    readonly safeLookup: LookupFunction = (hostname, options, callback) => {
        lookupCallback(
            hostname,
            { ...options, all: true },
            (error, addresses: LookupAddress[]) => {
                if (error) return callback(error, "", 0);
                if (
                    !this.allowPrivateNetwork() &&
                    (addresses.length === 0 ||
                        addresses.some(({ address }) =>
                            this.isPrivateIp(address),
                        ))
                ) {
                    return callback(
                        new Error(
                            "Outbound URL target resolves to a private or loopback IP",
                        ),
                        "",
                        0,
                    );
                }
                if (options.all) return callback(null, addresses);
                return callback(
                    null,
                    addresses[0].address,
                    addresses[0].family,
                );
            },
        );
    };

    /**
     * GET a URL that passed {@link assertSafeUrl}, validating the connected
     * address, bounding time and response size, and not following redirects.
     */
    async get(
        url: string,
        options: OutboundGetOptions,
    ): Promise<OutboundResponse> {
        await this.assertSafeUrl(url);
        const target = new URL(url);
        const send = target.protocol === "https:" ? httpsRequest : httpRequest;
        return new Promise<OutboundResponse>((resolve, reject) => {
            // Settle once: an aborted oversized response must never resolve
            // with truncated data.
            let settled = false;
            const fail = (error: Error) => {
                if (settled) return;
                settled = true;
                request.destroy();
                reject(error);
            };
            const request = send(
                target,
                {
                    method: "GET",
                    headers: options.headers,
                    lookup: this.safeLookup,
                    // No connection pooling: every request opens a fresh
                    // connection, so the address check in safeLookup always
                    // runs instead of reusing a socket from another request.
                    agent: false,
                    timeout: options.timeoutMs,
                },
                (response) => {
                    const chunks: Buffer[] = [];
                    let size = 0;
                    response.on("data", (chunk: Buffer) => {
                        size += chunk.length;
                        if (size > options.maxBytes) {
                            fail(
                                new Error(
                                    `Outbound response exceeds ${options.maxBytes} bytes`,
                                ),
                            );
                            return;
                        }
                        chunks.push(chunk);
                    });
                    response.on("end", () => {
                        if (settled) return;
                        settled = true;
                        const bytes = Buffer.concat(chunks);
                        resolve({
                            status: response.statusCode ?? 0,
                            location: response.headers.location,
                            contentType: response.headers["content-type"],
                            body: bytes.toString("utf8"),
                            bytes,
                        });
                    });
                    response.on("error", fail);
                },
            );
            request.on("timeout", () =>
                fail(
                    new Error(
                        `Outbound request timed out after ${options.timeoutMs} ms`,
                    ),
                ),
            );
            request.on("error", fail);
            request.end();
        });
    }

    /**
     * {@link get} that follows up to `maxRedirects` redirects. Every hop goes
     * through {@link get}, so a public URL cannot redirect to a blocked target.
     */
    async getFollowingRedirects(
        url: string,
        options: OutboundGetOptions & { maxRedirects: number },
    ): Promise<OutboundFinalResponse> {
        let currentUrl = url;
        for (let hop = 0; hop <= options.maxRedirects; hop++) {
            const response = await this.get(currentUrl, options);
            if (response.status < 300 || response.status >= 400) {
                return { ...response, url: currentUrl };
            }
            if (!response.location) {
                throw new BadRequestException(
                    `Redirect from ${currentUrl} has no location header`,
                );
            }
            currentUrl = new URL(response.location, currentUrl).toString();
        }
        throw new BadRequestException(
            `Outbound request exceeded ${options.maxRedirects} redirects`,
        );
    }

    async assertSafeUrl(url: string): Promise<void> {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw new BadRequestException("Invalid outbound URL");
        }

        const protocol = parsed.protocol.toLowerCase();
        if (
            protocol !== "https:" &&
            !(protocol === "http:" && this.allowHttp())
        ) {
            throw new BadRequestException(
                "Outbound URL must use HTTPS in this environment",
            );
        }

        const hostname = parsed.hostname.toLowerCase();
        const allowlistedHosts = this.allowedHosts();
        if (
            allowlistedHosts.length > 0 &&
            !allowlistedHosts.some(
                (entry) => hostname === entry || hostname.endsWith(`.${entry}`),
            )
        ) {
            throw new BadRequestException(
                "Outbound URL host is not in the allowlist",
            );
        }

        if (this.allowPrivateNetwork()) {
            return;
        }

        if (this.isReservedHost(hostname)) {
            throw new BadRequestException(
                "Outbound URL host is not allowed in this environment",
            );
        }

        const directIpVersion = isIP(hostname);
        if (directIpVersion > 0) {
            if (this.isPrivateIp(hostname)) {
                throw new BadRequestException(
                    "Outbound URL target resolves to a private or loopback IP",
                );
            }
            return;
        }

        let resolved;
        try {
            resolved = await lookup(hostname, { all: true, verbatim: true });
        } catch {
            throw new BadRequestException(
                "Outbound URL host cannot be resolved",
            );
        }

        if (resolved.length === 0) {
            throw new BadRequestException(
                "Outbound URL host cannot be resolved",
            );
        }

        if (resolved.some((entry) => this.isPrivateIp(entry.address))) {
            throw new BadRequestException(
                "Outbound URL target resolves to a private or loopback IP",
            );
        }
    }

    private allowHttp(): boolean {
        return this.readBoolean("OUTBOUND_URL_ALLOW_HTTP", false);
    }

    private allowPrivateNetwork(): boolean {
        return this.readBoolean("OUTBOUND_URL_ALLOW_PRIVATE_NETWORK", false);
    }

    private readBoolean(key: string, fallback: boolean): boolean {
        const configured = this.configService.get<string | boolean>(
            key,
            fallback,
        );
        if (configured === undefined || configured === null) {
            return fallback;
        }
        if (typeof configured === "boolean") {
            return configured;
        }
        return configured.toLowerCase() === "true";
    }

    private allowedHosts(): string[] {
        const raw = this.configService.get<string>(
            "OUTBOUND_URL_ALLOWED_HOSTS",
            "",
        );
        if (!raw) return [];
        return raw
            .split(",")
            .map((value) => value.trim().toLowerCase())
            .filter((value) => value.length > 0);
    }

    private isReservedHost(hostname: string): boolean {
        return hostname === "localhost" || hostname.endsWith(".localhost");
    }

    private isPrivateIp(address: string): boolean {
        const normalized = address.toLowerCase();

        if (normalized.startsWith("::ffff:")) {
            return this.isPrivateIp(normalized.slice("::ffff:".length));
        }

        const version = isIP(normalized);
        if (version === 4) {
            const octets = normalized
                .split(".")
                .map((v) => Number.parseInt(v, 10));
            const [a, b] = octets;
            if (a === 10) return true;
            if (a === 127) return true;
            if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
            if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
            if (a === 169 && b === 254) return true;
            if (a === 172 && b >= 16 && b <= 31) return true;
            if (a === 192 && b === 168) return true;
            if (a === 0) return true;
            return false;
        }

        if (version === 6) {
            if (normalized === "::1" || normalized === "::") return true;
            if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
                return true;
            }
            if (/^fe[89ab]/i.test(normalized)) return true;
            return false;
        }

        return true;
    }
}
