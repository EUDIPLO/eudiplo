import {
    OAuth2Client,
    OAuth2HttpError,
    OAuth2Token,
} from "@badgateway/oauth2-client";
import { HttpService } from "@nestjs/axios";
import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { OutboundUrlPolicyService } from "../webhook/outbound-url-policy.service.js";
import { RegistrarConfigEntity } from "./entities/registrar-config.entity.js";
import { createClient, createConfig } from "./generated/client/index.js";
import {
    relyingPartyControllerFindAll,
    relyingPartyControllerRegister,
} from "./generated/index.js";
import type { ClientOptions } from "./generated/types.gen.js";
import { registrarFetch } from "./registrar-http.js";

/**
 * Cached OAuth2 token with its expiration time.
 */
interface CachedToken {
    token: string;
    expiresAt: number;
}

/**
 * Handles OAuth2 token acquisition/caching and low-level registrar client
 * creation. Also provides {@link getRelyingPartyId} which is shared by both
 * access-certificate and registration-certificate flows.
 */
@Injectable()
export class RegistrarAuthService {
    private readonly logger = new Logger(RegistrarAuthService.name);

    private readonly tokenCache = new Map<string, CachedToken>();

    /** `fetch` under the outbound URL policy for all registrar requests. */
    private readonly fetch: typeof fetch;

    constructor(
        @InjectRepository(RegistrarConfigEntity)
        private readonly configRepository: Repository<RegistrarConfigEntity>,
        private readonly outboundUrlPolicy: OutboundUrlPolicyService,
        http: HttpService,
    ) {
        this.fetch = registrarFetch(http, outboundUrlPolicy);
    }

    /**
     * Check the configured registrar and OIDC URLs against the outbound URL
     * policy, so a configuration pointing at a blocked target is rejected
     * with a clear error before it is saved.
     */
    async assertSafeUrls(urls: {
        registrarUrl?: string;
        oidcUrl?: string;
    }): Promise<void> {
        await Promise.all(
            [urls.registrarUrl, urls.oidcUrl]
                .filter((url): url is string => url !== undefined)
                .map((url) => this.outboundUrlPolicy.assertSafeUrl(url)),
        );
    }

    /**
     * Test OIDC credentials by attempting to obtain an access token.
     * @throws BadRequestException if authentication fails
     */
    async testCredentials(config: {
        oidcUrl: string;
        clientId: string;
        clientSecret?: string;
        username: string;
        password: string;
    }): Promise<void> {
        const oauth2Client = await this.createOAuth2Client(config);

        try {
            await oauth2Client.password({
                username: config.username,
                password: config.password,
            });
            this.logger.log("Registrar credentials validated successfully");
        } catch (error: any) {
            if (error instanceof OAuth2HttpError) {
                this.logger.error(
                    `Registrar rejected credentials (HTTP ${error.httpCode}): ${error.message}`,
                );
                throw new BadRequestException(
                    `Invalid registrar credentials (HTTP ${error.httpCode}). Please check your username, password, client ID and secret.`,
                );
            }
            // Network-level failure (DNS, connection refused, timeout, a
            // blocked target, etc.). The details stay in the log: echoing them
            // would tell the caller whether an address is reachable.
            this.logger.warn(
                `Registrar is not reachable during credential check: ${error.message}`,
            );
            throw new ServiceUnavailableException(
                "Registrar OIDC endpoint is not reachable. Credentials could not be verified.",
            );
        }
    }

    /**
     * Get or refresh the access token for a tenant using the ROPC flow.
     */
    async getAccessToken(tenantId: string): Promise<string> {
        const cached = this.tokenCache.get(tenantId);
        if (cached && cached.expiresAt > Date.now() + 5000) {
            return cached.token;
        }

        const config = await this.configRepository.findOneBy({ tenantId });
        if (!config) {
            throw new NotFoundException(
                `No registrar configuration found for tenant ${tenantId}`,
            );
        }

        const oauth2Client = await this.createOAuth2Client(config);

        let tokenResponse: OAuth2Token;
        try {
            tokenResponse = await oauth2Client.password({
                username: config.username,
                password: config.password,
            });
        } catch (error: any) {
            this.logger.error(
                `[${tenantId}] Failed to obtain access token: ${error.message}`,
            );
            throw new BadRequestException(
                error instanceof OAuth2HttpError
                    ? `Failed to authenticate with registrar (HTTP ${error.httpCode})`
                    : "Failed to authenticate with registrar: OIDC endpoint is not reachable",
            );
        }

        const expiresAt =
            typeof tokenResponse.expiresAt === "number"
                ? tokenResponse.expiresAt
                : Date.now() + 3600 * 1000;

        this.tokenCache.set(tenantId, {
            token: tokenResponse.accessToken,
            expiresAt,
        });

        return tokenResponse.accessToken;
    }

    /**
     * Create a configured registrar API client for the given tenant.
     *
     * Every call gets its own client: a shared client reconfigured per call
     * could send one tenant's request with another tenant's URL and token
     * when both call the registrar at the same time.
     */
    async getClient(tenantId: string) {
        const config = await this.configRepository.findOneBy({ tenantId });
        if (!config) {
            throw new NotFoundException(
                `No registrar configuration found for tenant ${tenantId}`,
            );
        }

        // Checked before the token is requested, so no credentials are sent
        // for a configuration whose registrar URL is blocked.
        await this.outboundUrlPolicy.assertSafeUrl(config.registrarUrl);
        const accessToken = await this.getAccessToken(tenantId);

        return createClient(
            createConfig<ClientOptions>({
                baseUrl: config.registrarUrl,
                auth: () => accessToken,
                fetch: this.fetch,
            }),
        );
    }

    /**
     * Get the relying party ID from the registrar.
     * If none exists yet, one is registered on the fly.
     */
    async getRelyingPartyId(tenantId: string): Promise<string> {
        const client = await this.getClient(tenantId);

        const res = await relyingPartyControllerFindAll({ client });
        if (res.error) {
            this.logger.error(
                { error: res.error },
                `[${tenantId}] Failed to fetch relying parties`,
            );
            throw new BadRequestException(
                "Failed to fetch relying parties from registrar",
            );
        }

        const relyingParties = res.data || [];
        if (relyingParties.length === 0) {
            const createRes = await relyingPartyControllerRegister({
                client,
                body: {},
            });
            if (createRes.error) {
                this.logger.error(
                    { error: createRes.error },
                    `[${tenantId}] Failed to register relying party`,
                );
                throw new BadRequestException(
                    "Failed to register relying party at registrar",
                );
            }
            return createRes.data!.id;
        }

        return relyingParties[0].id;
    }

    /**
     * OAuth2 client for the registrar's OIDC provider. The discovery document
     * can name a token endpoint on any host, so the client's own requests go
     * through the outbound URL policy too.
     */
    private async createOAuth2Client(config: {
        oidcUrl: string;
        clientId: string;
        clientSecret?: string;
    }): Promise<OAuth2Client> {
        await this.outboundUrlPolicy.assertSafeUrl(config.oidcUrl);
        return new OAuth2Client({
            server: `${config.oidcUrl}/protocol/openid-connect/token`,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            discoveryEndpoint: `${config.oidcUrl}/.well-known/openid-configuration`,
            fetch: this.fetch,
        });
    }

    /**
     * Remove the cached token for a tenant (e.g. after config changes).
     */
    invalidateToken(tenantId: string): void {
        this.tokenCache.delete(tenantId);
    }
}
