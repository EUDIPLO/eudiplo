import { readFile } from "node:fs/promises";

/**
 * TLS options passed to the HTTPS server (`httpsOptions` of NestFactory).
 */
export interface TlsOptions {
    /** Server certificate followed by its intermediate CA certificates (PEM). */
    cert: Buffer;
    key: Buffer;
    passphrase?: string;
}

/**
 * Thrown when built-in TLS is enabled but cannot be configured. Startup must
 * fail instead of silently serving plain HTTP.
 */
export class TlsConfigurationError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "TlsConfigurationError";
    }
}

const PEM_CERTIFICATE =
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

function pemCertificates(pem: string): string[] {
    return pem.match(PEM_CERTIFICATE) ?? [];
}

/**
 * Append the CA certificates to the served certificate chain. Certificates
 * that the certificate file already contains (e.g. a `fullchain.pem`) are not
 * added twice.
 */
export function appendCertificateChain(cert: Buffer, ca: Buffer): Buffer {
    const served = cert.toString("utf8");
    const present = new Set(pemCertificates(served));
    const missing = pemCertificates(ca.toString("utf8")).filter(
        (certificate) => !present.has(certificate),
    );
    if (missing.length === 0) {
        return cert;
    }
    const separator = served.endsWith("\n") ? "" : "\n";
    return Buffer.from(`${served}${separator}${missing.join("\n")}\n`, "utf8");
}

async function readTlsFile(variable: string, path: string): Promise<Buffer> {
    try {
        return await readFile(path);
    } catch (error) {
        throw new TlsConfigurationError(
            `TLS_ENABLED is true but ${variable} (${path}) cannot be read: ${(error as Error).message}`,
            { cause: error },
        );
    }
}

/**
 * Load the TLS options for the HTTPS server from the `TLS_*` environment
 * variables. They are read directly from process.env because the options are
 * needed to create the Nest application.
 *
 * Returns `undefined` when TLS is disabled. When TLS is enabled, a missing or
 * unreadable certificate, key or CA file is a configuration error.
 */
export async function loadTlsOptions(
    env: NodeJS.ProcessEnv = process.env,
): Promise<TlsOptions | undefined> {
    if (env.TLS_ENABLED?.trim().toLowerCase() !== "true") {
        return undefined;
    }

    const certPath = env.TLS_CERT_PATH?.trim();
    const keyPath = env.TLS_KEY_PATH?.trim();
    const missing = [
        ...(certPath ? [] : ["TLS_CERT_PATH"]),
        ...(keyPath ? [] : ["TLS_KEY_PATH"]),
    ];
    if (!certPath || !keyPath) {
        throw new TlsConfigurationError(
            `TLS_ENABLED is true but ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set. Set both, or set TLS_ENABLED=false to serve plain HTTP (e.g. behind a TLS-terminating reverse proxy).`,
        );
    }

    let cert = await readTlsFile("TLS_CERT_PATH", certPath);
    const key = await readTlsFile("TLS_KEY_PATH", keyPath);
    if (pemCertificates(cert.toString("utf8")).length === 0) {
        throw new TlsConfigurationError(
            `TLS_CERT_PATH (${certPath}) does not contain a PEM certificate.`,
        );
    }

    const caPath = env.TLS_CA_PATH?.trim();
    if (caPath) {
        const ca = await readTlsFile("TLS_CA_PATH", caPath);
        if (pemCertificates(ca.toString("utf8")).length === 0) {
            throw new TlsConfigurationError(
                `TLS_CA_PATH (${caPath}) does not contain a PEM certificate.`,
            );
        }
        cert = appendCertificateChain(cert, ca);
    }

    const options: TlsOptions = { cert, key };
    if (env.TLS_KEY_PASSPHRASE) {
        options.passphrase = env.TLS_KEY_PASSPHRASE;
    }
    return options;
}
