import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { OpenTelemetryModule } from "nestjs-otel";
import { AuthSettingsModule } from "../auth/auth-settings.module.js";
import { AppController } from "./app/app.controller.js";
import { HealthModule } from "./health/health.module.js";
import { TraceIdInterceptor } from "./interceptors/trace-id.interceptor.js";

/**
 * Core Module - Platform infrastructure and observability
 *
 * Responsibilities:
 * - Service information endpoint
 * - Health checks
 * - OpenTelemetry metrics and tracing (via nestjs-otel)
 * - Trace ID propagation to HTTP response headers (X-Trace-Id)
 *
 * Tracing:
 * - HTTP spans are automatically created by @opentelemetry/instrumentation-http
 * - Use @Span() decorator from nestjs-otel for business logic spans
 * - Use @Traceable() class decorator to trace all methods of a service
 * - X-Trace-Id header is added to all responses for client-side debugging
 */
@Module({
    imports: [
        AuthSettingsModule,
        HealthModule,
        OpenTelemetryModule.forRoot({
            metrics: {
                hostMetrics: true,
            },
        }),
    ],
    controllers: [AppController],
    providers: [
        {
            provide: APP_INTERCEPTOR,
            useClass: TraceIdInterceptor,
        },
    ],
    exports: [HealthModule],
})
export class CoreModule {}
