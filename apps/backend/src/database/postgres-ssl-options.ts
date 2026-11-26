import { readFileSync } from "node:fs";
import { TlsOptions } from "node:tls";
import { fileAccessHint } from "../shared/utils/file-access-hint.util.js";

function parseBoolean(value: unknown): boolean | undefined {
    if (typeof value === "boolean") {
        return value;
    }

    if (typeof value !== "string") {
        return undefined;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
        return true;
    }

    if (normalized === "false") {
        return false;
    }

    return undefined;
}

function parseOptionalString(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalFile(path: string, variableName: string): Buffer {
    try {
        return readFileSync(path);
    } catch (error) {
        throw new Error(
            `Failed to read ${variableName} at path \"${path}\": ${error instanceof Error ? error.message : String(error)}.${fileAccessHint(error, path)}`,
        );
    }
}

/**
 * Build PostgreSQL SSL settings from environment/config values.
 *
 * Supported variables:
 * - DB_SSL=true|false
 * - DB_SSL_REJECT_UNAUTHORIZED=true|false
 * - DB_SSL_CA_PATH=/path/to/ca.crt
 * - DB_SSL_CERT_PATH=/path/to/client.crt
 * - DB_SSL_KEY_PATH=/path/to/client.key
 * - DB_SSL_KEY_PASSPHRASE=secret
 */
export function buildPostgresSslOptions(
    readValue: (key: string) => unknown,
): boolean | TlsOptions {
    const sslEnabled = parseBoolean(readValue("DB_SSL")) ?? false;
    if (!sslEnabled) {
        return false;
    }

    const rejectUnauthorized = parseBoolean(
        readValue("DB_SSL_REJECT_UNAUTHORIZED"),
    );
    const caPath = parseOptionalString(readValue("DB_SSL_CA_PATH"));
    const certPath = parseOptionalString(readValue("DB_SSL_CERT_PATH"));
    const keyPath = parseOptionalString(readValue("DB_SSL_KEY_PATH"));
    const keyPassphrase = parseOptionalString(
        readValue("DB_SSL_KEY_PASSPHRASE"),
    );

    if (
        rejectUnauthorized === undefined &&
        !caPath &&
        !certPath &&
        !keyPath &&
        !keyPassphrase
    ) {
        // Preserve existing behavior when only DB_SSL=true is set.
        return true;
    }

    const sslOptions: TlsOptions = {};

    if (rejectUnauthorized !== undefined) {
        sslOptions.rejectUnauthorized = rejectUnauthorized;
    }

    if (caPath) {
        sslOptions.ca = readOptionalFile(caPath, "DB_SSL_CA_PATH");
    }

    if (certPath) {
        sslOptions.cert = readOptionalFile(certPath, "DB_SSL_CERT_PATH");
    }

    if (keyPath) {
        sslOptions.key = readOptionalFile(keyPath, "DB_SSL_KEY_PATH");
    }

    if (keyPassphrase) {
        sslOptions.passphrase = keyPassphrase;
    }

    return sslOptions;
}
