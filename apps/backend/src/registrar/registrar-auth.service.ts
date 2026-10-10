import {
    OAuth2Client,
    OAuth2HttpError,
    OAuth2Token,
} from "@badgateway/oauth2-client";
import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { RegistrarConfigEntity } from "./entities/registrar-config.entity.js";
import { client as registrarClient } from "./generated/client.gen.js";
import {
    relyingPartyControllerFindAll,
    relyingPartyControllerRegister,
} from "./generated/index.js";

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

    constructor(
        @InjectRepository(RegistrarConfigEntity)
        private readonly configRepository: Repository<RegistrarConfigEntity>,
    ) {}

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
        const oauth2Client = new OAuth2Client({
            server: `${config.oidcUrl}/protocol/openid-connect/token`,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            discoveryEndpoint: `${config.oidcUrl}/.well-known/openid-configuration`,
        });

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
            // Network-level failure (DNS, connection refused, timeout, etc.)
            this.logger.warn(
                `Registrar is not reachable during credential check: ${error.message}`,
            );
            throw new ServiceUnavailableException(
                `Registrar OIDC endpoint is not reachable. Credentials could not be verified. Error: ${error.message}`,
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

        const oauth2Client = new OAuth2Client({
            server: `${config.oidcUrl}/protocol/openid-connect/token`,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            discoveryEndpoint: `${config.oidcUrl}/.well-known/openid-configuration`,
        });

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
                `Failed to authenticate with registrar: ${error.message}`,
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
     */
    async getClient(tenantId: string) {
        const config = await this.configRepository.findOneBy({ tenantId });
        if (!config) {
            throw new NotFoundException(
                `No registrar configuration found for tenant ${tenantId}`,
            );
        }

        const client = registrarClient;
        const accessToken = await this.getAccessToken(tenantId);

        client.setConfig({
            baseUrl: config.registrarUrl,
            auth: () => accessToken,
        });

        return client;
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
     * Remove the cached token for a tenant (e.g. after config changes).
     */
    invalidateToken(tenantId: string): void {
        this.tokenCache.delete(tenantId);
    }
}
