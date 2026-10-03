import { writeFileSync } from "node:fs";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { NextFunction, Request, Response } from "express";
import { Logger } from "nestjs-pino";
import { cleanupOpenApiDoc } from "nestjs-zod";
import { AllExceptionsFilter } from "./all-exceptions.filter.js";
import { AppModule } from "./app.module.js";
import {
    configureCors,
    filterOpenApiPaths,
    GLOBAL_PREFIX_EXCLUSIONS,
} from "./main.helpers.js";
import { splitCorsOrigins } from "./platform/config/cors-validation.schema.js";
import { getActiveSkipFlags } from "./platform/config/skip-validation.schema.js";
import { loadTlsOptions } from "./platform/config/tls-options.js";
import { ValidationErrorFilter } from "./shared/common/filters/validation-error.filter.js";
import { createAppValidationPipe } from "./shared/common/zod/zod-schema.util.js";
import { registerTolerantX509Extensions } from "./shared/utils/x509-tolerant-extensions.js";

/**
 * Bootstrap function to initialize the NestJS application.
 */
async function bootstrap() {
    // Tolerate malformed X.509 extensions (e.g. the nested-Extension
    // issuerAltName in the EU AV reference certificates) before any
    // certificate is parsed.
    registerTolerantX509Extensions();

    // Load TLS options if configured. Fails startup when TLS is enabled but
    // the certificate or key cannot be loaded, instead of falling back to HTTP.
    const tlsOptions = await loadTlsOptions();
    const isTlsEnabled = tlsOptions !== undefined;

    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
        bufferLogs: true,
        snapshot: true,
        httpsOptions: tlsOptions,
    });

    // Set explicit body size limits (security best practice)
    // Parse encrypted credential requests sent as application/jwt (JWE compact serialization)
    // Must be registered BEFORE the JSON parser so it takes precedence for this content type
    app.useBodyParser("text", {
        type: "application/jwt",
        limit: "10mb",
    });
    app.useBodyParser("json", { limit: "10mb" });

    // Global route prefix: all management endpoints under /api/,
    // protocol endpoints (wallet-facing) stay at root for compliance
    app.setGlobalPrefix("api", { exclude: GLOBAL_PREFIX_EXCLUSIONS });

    // Global exception filter for ValidationError
    app.useGlobalFilters(
        new ValidationErrorFilter(),
        new AllExceptionsFilter(),
    );

    // Use Pino logger for all NestJS logging (including built-in Logger instances)
    // This ensures LOG_LEVEL env var is respected across all services
    app.useLogger(app.get(Logger));

    app.useGlobalPipes(createAppValidationPipe());

    const configService = app.get(ConfigService);
    const publicUrl = configService.getOrThrow<string>("PUBLIC_URL");

    const corsOrigins = splitCorsOrigins(
        configService.get<string>("CORS_ORIGINS"),
    );
    configureCors(app, corsOrigins);

    const useExternalOIDC = configService.get<string>("OIDC");

    // ── Management API OpenAPI config ────────────────────────────────
    const managementConfigBuilder = new DocumentBuilder()
        .setTitle("EUDIPLO Management API")
        .setDescription(
            "API for managing credentials, sessions, keys, and configurations. " +
                "All endpoints require OAuth2 authentication.",
        )
        .setExternalDoc("Documentation", "https://docs.eudiplo.dev/")
        .setOpenAPIVersion("3.1.0")
        .setVersion(process.env.VERSION ?? "main");

    if (useExternalOIDC) {
        const oidcIssuerUrl = configService.get<string>(
            "OIDC_INTERNAL_ISSUER_URL",
        );
        if (oidcIssuerUrl) {
            managementConfigBuilder.addOAuth2(
                {
                    type: "openIdConnect",
                    openIdConnectUrl: `${oidcIssuerUrl}/.well-known/openid-configuration`,
                },
                "oauth2",
            );
        }
    } else if (publicUrl) {
        managementConfigBuilder.addOAuth2(
            {
                type: "oauth2",
                flows: {
                    clientCredentials: {
                        tokenUrl: `${publicUrl}/api/oauth2/token`,
                        scopes: {},
                    },
                },
            },
            "oauth2",
        );
    }

    const managementDocConfig = managementConfigBuilder.build();

    // ── Protocol API OpenAPI config ──────────────────────────────────
    const protocolDocConfig = new DocumentBuilder()
        .setTitle("EUDIPLO Protocol API")
        .setDescription(
            "Wallet-facing protocol endpoints for OID4VCI, OID4VP, and related standards. " +
                "These endpoints are public and secured at the protocol level (DPoP, Wallet Attestation, etc.).",
        )
        .setExternalDoc("Documentation", "https://docs.eudiplo.dev/")
        .setOpenAPIVersion("3.1.0")
        .setVersion(process.env.VERSION ?? "main")
        .build();

    // ── Document factories ───────────────────────────────────────────
    const fullDocFactory = () =>
        cleanupOpenApiDoc(
            SwaggerModule.createDocument(app, managementDocConfig),
        );

    const managementDocFactory = () =>
        filterOpenApiPaths(fullDocFactory(), (path) =>
            path.startsWith("/api/"),
        );

    const protocolDocFactory = () =>
        filterOpenApiPaths(
            cleanupOpenApiDoc(
                SwaggerModule.createDocument(app, protocolDocConfig),
            ),
            (path) => !path.startsWith("/api/"),
        );

    if (process.env.DOC_GENERATE) {
        writeFileSync(
            "swagger-management.json",
            JSON.stringify(managementDocFactory(), null, 2),
        );
        writeFileSync(
            "swagger-protocol.json",
            JSON.stringify(protocolDocFactory(), null, 2),
        );
        process.exit();
    } else {
        const sharedSwaggerOptions = {
            swaggerOptions: {
                persistAuthorization: true,
                displayRequestDuration: true,
                filter: true,
                showExtensions: true,
                showCommonExtensions: true,
                tryItOutEnabled: true,
                deepLinking: true,
                displayOperationId: false,
                defaultModelsExpandDepth: 1,
                defaultModelExpandDepth: 1,
                docExpansion: "list",
                operationsSorter: "alpha",
                tagsSorter: "alpha",
            },
        };

        // Cache-control headers for Swagger UI assets
        for (const swaggerPath of ["/api/docs", "/docs"]) {
            app.use(
                swaggerPath,
                (_req: Request, res: Response, next: NextFunction) => {
                    res.setHeader(
                        "Cache-Control",
                        "no-cache, no-store, must-revalidate",
                    );
                    res.setHeader("Pragma", "no-cache");
                    res.setHeader("Expires", "0");
                    next();
                },
            );
        }

        SwaggerModule.setup("/api/docs", app, managementDocFactory, {
            ...sharedSwaggerOptions,
            customSiteTitle: "EUDIPLO Management API",
        });

        SwaggerModule.setup("/docs", app, protocolDocFactory, {
            ...sharedSwaggerOptions,
            customSiteTitle: "EUDIPLO Protocol API",
        });

        const logger =
            app.getHttpAdapter().getInstance().locals?.logger || console;
        const oidc = configService.get<string>("OIDC");

        await app.listen(process.env.PORT ?? 3000).then(() => {
            const port = process.env.PORT ?? 3000;
            const publicUrl = configService.get<string>("PUBLIC_URL");
            const version = process.env.VERSION ?? "main";
            const nodeEnv = process.env.NODE_ENV ?? "development";
            const protocol = isTlsEnabled ? "https" : "http";
            const baseUrl = publicUrl || `${protocol}://localhost:${port}`;

            logger.log("");
            logger.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            logger.log("🚀 EUDIPLO Service Started Successfully");
            logger.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            logger.log(`📦 Version:        ${version}`);
            logger.log(`🌍 Environment:    ${nodeEnv}`);
            logger.log(`🔌 Port:           ${port}`);
            logger.log(
                `🔒 TLS:            ${isTlsEnabled ? "Enabled" : "Disabled (use reverse proxy for HTTPS)"}`,
            );
            logger.log(`🌐 Public URL:     ${publicUrl || "Not configured"}`);
            const corsStatus =
                corsOrigins.length > 0
                    ? `Management API restricted to ${corsOrigins.length} origin(s)`
                    : "All origins allowed";
            logger.log(`🔀 CORS:           ${corsStatus}`);
            logger.log("");
            logger.log("📚 API Documentation:");
            logger.log(`   → Management:   ${baseUrl}/api/docs`);
            logger.log(`   → Protocol:     ${baseUrl}/docs`);
            logger.log(`   → Full Docs:    https://docs.eudiplo.dev/`);
            logger.log("");
            logger.log("🏥 Health Check:");
            logger.log(`   → Endpoint:     ${baseUrl}/health`);
            logger.log("");
            logger.log("🔐 Authentication:");
            if (oidc) {
                logger.log(`   → Mode:         External OIDC`);
                logger.log(`   → Provider:     ${oidc}`);
            } else {
                logger.log(
                    `   → Mode:         Integrated OAuth2 (Client Credentials)`,
                );
                logger.log(`   → Token URL:    ${publicUrl}/api/oauth2/token`);
            }

            const activeSkipFlags = getActiveSkipFlags((key) =>
                configService.get(key),
            );
            if (activeSkipFlags.length > 0) {
                logger.log("");
                logger.warn(
                    "⚠️  Checks skipped (development/testing only, never in production):",
                );
                for (const flag of activeSkipFlags) {
                    logger.warn(`   → ${flag}=true`);
                }
            }
        });
    }
}
await bootstrap();
