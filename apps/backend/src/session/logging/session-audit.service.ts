import { Inject, Injectable } from "@nestjs/common";
import { SessionLogLevel } from "../entities/session-log-entry.entity.js";
import { SessionLogStoreService } from "./session-log-store.service.js";
import {
    SESSION_LOGGING_SETTINGS,
    type SessionLoggingSettings,
} from "./session-logging-settings.js";

/**
 * Context for audit logging operations.
 */
export interface AuditLogContext {
    sessionId: string;
    tenantId?: string;
    flowType: "OID4VCI" | "OID4VP" | "ISO18013";
    stage?: string;
}

/**
 * Service for persisting audit events to the database.
 *
 * This service is focused on compliance/audit logging only — it writes to PostgreSQL
 * so that audit events are visible in the client UI and useful for compliance/proof.
 *
 * **Audit events** (persisted to DB): flow_start, flow_complete, flow_error,
 * credential_issuance, credential_verification.
 *
 * For debug/observability logging, use `PinoLogger` directly — logs are exported
 * to Loki via the OpenTelemetry transport.
 */
@Injectable()
export class SessionAuditService {
    private readonly isEnabled: boolean;
    private readonly verbose: boolean;

    constructor(
        @Inject(SESSION_LOGGING_SETTINGS)
        private readonly settings: SessionLoggingSettings,
        private readonly logStore: SessionLogStoreService,
    ) {
        this.isEnabled = this.settings.enabled;
        this.verbose = this.settings.storeMode === "verbose";
    }

    private persistLog(
        context: AuditLogContext,
        level: SessionLogLevel,
        message: string,
        stage?: string,
        detail?: Record<string, unknown>,
    ): void {
        this.logStore
            .append(context.sessionId, level, message, stage, detail)
            .catch(() => {});
    }

    private shouldLog(): boolean {
        return this.isEnabled;
    }

    /**
     * Log session flow start (audit event - persisted to DB)
     */
    logFlowStart(context: AuditLogContext, additionalData?: any) {
        if (!this.shouldLog()) return;

        const message = `[${context.flowType}] Flow started for session ${context.sessionId} in tenant ${context.tenantId}`;
        this.persistLog(
            context,
            "info",
            message,
            "initialization",
            additionalData,
        );
    }

    /**
     * Log session flow completion (audit event - persisted to DB)
     */
    logFlowComplete(context: AuditLogContext, additionalData?: any) {
        if (!this.shouldLog()) return;

        const message = `[${context.flowType}] Flow completed for session ${context.sessionId}`;
        this.persistLog(context, "info", message, "completion", additionalData);
    }

    /**
     * Log session flow error (audit event - persisted to DB)
     */
    logFlowError(context: AuditLogContext, error: Error, additionalData?: any) {
        if (!this.shouldLog()) return;

        const message = `[${context.flowType}] Flow error for session ${context.sessionId}: ${error.message}`;
        this.persistLog(context, "error", message, "error", {
            errorName: error.name,
            errorMessage: error.message,
            ...(this.verbose && { errorStack: error.stack }),
            ...additionalData,
        });
    }

    /**
     * Log credential issuance step (audit event - persisted to DB)
     */
    logCredentialIssuance(
        context: AuditLogContext,
        credentialType: string,
        additionalData?: any,
    ) {
        if (!this.shouldLog()) return;

        const message = `[${context.flowType}] Issuing credential of type ${credentialType} for session ${context.sessionId}`;
        this.persistLog(context, "info", message, "credential_creation", {
            credentialType,
            ...additionalData,
        });
    }

    /**
     * Log credential presentation verification (audit event - persisted to DB)
     */
    logCredentialVerification(
        context: AuditLogContext,
        verificationResult: boolean,
        additionalData?: any,
    ) {
        if (!this.shouldLog()) return;

        const message = `[${context.flowType}] Credential verification ${verificationResult ? "succeeded" : "failed"} for session ${context.sessionId}`;
        this.persistLog(context, "info", message, "verification", {
            verificationResult,
            ...additionalData,
        });
    }

    /**
     * Log generic session error (audit event - persisted to DB)
     */
    logError(
        context: AuditLogContext,
        error: Error,
        message: string,
        additionalData?: any,
    ) {
        if (!this.shouldLog()) return;

        const fullMessage = `[${context.flowType}] ${message}: ${error.message}`;
        this.persistLog(context, "error", fullMessage, context.stage, {
            errorName: error.name,
            errorMessage: error.message,
            ...(this.verbose && { errorStack: error.stack }),
            ...additionalData,
        });
    }
}
