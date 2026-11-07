import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { jwtVerify, SignJWT } from "jose";
import { AUTH_SETTINGS, type AuthSettings } from "./auth-settings.js";
import { InternalTokenPayload, TokenPayload } from "./token.decorator.js";

/** Lifetime of the access tokens the built-in OAuth2 server issues. */
export const ACCESS_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

export interface GenerateTokenOptions {
    expiresInSeconds: number;
    audience?: string;
    subject: string;
}

@Injectable()
export class JwtService {
    constructor(
        private readonly configService: ConfigService,
        @Inject(AUTH_SETTINGS) private readonly settings: AuthSettings,
    ) {}

    /**
     * Generate a JWT token for integrated OAuth2 server
     */
    async generateToken(
        payload: Omit<InternalTokenPayload, "iat" | "exp">,
        options: GenerateTokenOptions,
    ): Promise<string> {
        if (this.isUsingExternalOIDC()) {
            throw new Error(
                "Token generation is not available when using external OIDC provider. Use your external OIDC provider for token generation.",
            );
        }

        const secret = this.configService.getOrThrow<string>("MASTER_SECRET");
        const issuer = this.configService.getOrThrow<string>("JWT_ISSUER");
        // One clock read, so exp - iat is exactly the lifetime.
        const issuedAt = Math.floor(Date.now() / 1000);

        const secretKey = new TextEncoder().encode(secret);

        const jwt = new SignJWT({
            ...payload,
        })
            .setProtectedHeader({ alg: "HS256" })
            .setIssuedAt(issuedAt)
            .setIssuer(issuer)
            .setSubject(options.subject)
            .setExpirationTime(issuedAt + options.expiresInSeconds);

        if (options.audience) {
            jwt.setAudience(options.audience);
        }

        return await jwt.sign(secretKey);
    }

    /**
     * Verify a JWT token (for additional validation if needed)
     */
    async verifyToken(token: string): Promise<TokenPayload> {
        if (this.isUsingExternalOIDC()) {
            throw new Error(
                "Token verification is handled by external OIDC provider.",
            );
        }

        const secret = this.configService.getOrThrow<string>("MASTER_SECRET");
        const issuer = this.configService.getOrThrow<string>("JWT_ISSUER");

        const secretKey = new TextEncoder().encode(secret);

        try {
            const { payload } = (await jwtVerify(token, secretKey, {
                issuer,
                algorithms: ["HS256"],
            })) as { payload: TokenPayload };
            return payload;
        } catch (error: any) {
            throw new Error(`Invalid token: ${error.message}`);
        }
    }

    /**
     * Check if the service is using external OIDC provider
     */
    isUsingExternalOIDC(): boolean {
        return this.settings.mode !== "builtin";
    }
}
