import { connect } from "node:tls";
import type { DoctorCheck } from "../types.js";

export interface PeerCertificate {
    subject: string;
    issuer: string;
    validTo: Date;
}

export type CertificateReader = (url: URL) => Promise<PeerCertificate>;

/** Days before expiry at which the certificate check starts warning. */
const defaultExpiryWarningDays = 30;

const dayInMs = 24 * 60 * 60 * 1000;

export function evaluateCertificate(
    certificate: PeerCertificate,
    now: Date,
    warningDays = defaultExpiryWarningDays,
): DoctorCheck {
    const remainingDays = Math.floor(
        (certificate.validTo.getTime() - now.getTime()) / dayInMs,
    );
    const expiresOn = certificate.validTo.toISOString().slice(0, 10);

    if (remainingDays < 0) {
        return {
            name: "TLS certificate",
            status: "fail",
            message: `The certificate issued by ${certificate.issuer} expired on ${expiresOn}.`,
        };
    }
    if (remainingDays <= warningDays) {
        return {
            name: "TLS certificate",
            status: "warn",
            message: `The certificate expires on ${expiresOn}, in ${remainingDays} day(s). Renew it before then.`,
        };
    }
    return {
        name: "TLS certificate",
        status: "pass",
        message: `Valid until ${expiresOn} (${remainingDays} day(s) left), issued by ${certificate.issuer}.`,
    };
}

/**
 * Reads the peer certificate from a normally verified TLS connection.
 * Verification is never disabled: an untrusted or mismatched certificate
 * fails the handshake, and the check reports that failure.
 */
export const readPeerCertificate: CertificateReader = (url) =>
    new Promise((resolvePeer, rejectPeer) => {
        const socket = connect(
            {
                host: url.hostname,
                port: Number(url.port || 443),
                servername: url.hostname,
                rejectUnauthorized: true,
            },
            () => {
                const certificate = socket.getPeerCertificate();
                socket.end();
                if (!certificate || !certificate.valid_to) {
                    rejectPeer(new Error("no peer certificate was presented"));
                    return;
                }
                resolvePeer({
                    subject: String(certificate.subject?.CN ?? url.hostname),
                    issuer: String(certificate.issuer?.CN ?? "unknown issuer"),
                    validTo: new Date(certificate.valid_to),
                });
            },
        );
        socket.setTimeout(10_000, () => {
            socket.destroy();
            rejectPeer(new Error("the TLS handshake timed out"));
        });
        socket.once("error", (error) => {
            socket.destroy();
            rejectPeer(error);
        });
    });

export async function checkTlsCertificate(
    baseUrl: URL,
    now: Date,
    read: CertificateReader = readPeerCertificate,
    warningDays = defaultExpiryWarningDays,
): Promise<DoctorCheck> {
    if (baseUrl.protocol !== "https:") {
        return {
            name: "TLS certificate",
            status: "skip",
            message: `${baseUrl.origin} does not use HTTPS, so there is no certificate to check.`,
        };
    }
    try {
        return evaluateCertificate(await read(baseUrl), now, warningDays);
    } catch (error) {
        return {
            name: "TLS certificate",
            status: "fail",
            message: `The certificate of ${baseUrl.origin} could not be verified: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
