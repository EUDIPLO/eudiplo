import { X509Certificate } from "node:crypto";

/** What the default access key chain rule needs to know about a key chain. */
export interface AccessKeyChainCandidate {
    id: string;
    createdAt: Date;
    /** PEM of the active certificate, leaf first. */
    activeCertificate: string;
    /** Set for internal chains, whose own root CA signs the leaf. */
    rootCertificate?: string | null;
}

/**
 * Why a key chain of `usageType` cannot be the tenant's default key chain of
 * the usage type `entry` (a key of the key chain defaults), or undefined when
 * it can.
 */
export function defaultKeyChainUsageRefusal(
    entry: string,
    keyChainId: string,
    usageType: unknown,
): string | undefined {
    return usageType === entry
        ? undefined
        : `Key chain ${JSON.stringify(keyChainId)} has usage type ${JSON.stringify(usageType)}; the default ${entry} key chain needs usage type ${JSON.stringify(entry)}.`;
}

/**
 * Picks the access key chain used when a presentation configuration, the ISO
 * 18013-7 flow or the signed issuer metadata names none. A tenant can hold
 * several access key chains, for example one with a registrar certificate and
 * a self-signed one left from a failed enrollment, so the choice must not
 * depend on database order. In this order, EUDIPLO prefers:
 *
 * 1. a certificate valid at `now` over an expired or not yet valid one,
 *    which could not sign;
 * 2. a certificate issued by an external CA (the registrar or an imported
 *    certificate), over an internal chain (an External CA chain included),
 *    over a self-signed certificate;
 * 3. the key chain created first, then the smaller id (SQLite stores the
 *    creation time in seconds, so key chains created in the same second
 *    tie on it).
 *
 * A new key chain therefore only replaces the default when its certificate
 * is of a better kind or the current default's certificate is no longer
 * valid.
 */
export function pickDefaultAccessKeyChain<T extends AccessKeyChainCandidate>(
    candidates: T[],
    now: Date = new Date(),
): T | undefined {
    const ranked = candidates.map((candidate) => ({
        candidate,
        rank: rankCertificate(candidate, now),
    }));
    ranked.sort(
        (a, b) =>
            a.rank.validity - b.rank.validity ||
            a.rank.kind - b.rank.kind ||
            a.candidate.createdAt.getTime() - b.candidate.createdAt.getTime() ||
            compareIds(a.candidate.id, b.candidate.id),
    );
    return ranked[0]?.candidate;
}

/** Certificate kinds, best first. */
enum AccessCertificateKind {
    ExternallyIssued = 0,
    InternalChain = 1,
    SelfSigned = 2,
}

/** The kind of a key chain's certificate; self-signed when unreadable. */
function accessCertificateKind(
    candidate: Pick<
        AccessKeyChainCandidate,
        "activeCertificate" | "rootCertificate"
    >,
): AccessCertificateKind {
    if (candidate.rootCertificate) return AccessCertificateKind.InternalChain;
    const leaf = parseLeaf(candidate.activeCertificate);
    if (!leaf || isSelfSigned(leaf)) return AccessCertificateKind.SelfSigned;
    return AccessCertificateKind.ExternallyIssued;
}

function rankCertificate(
    candidate: AccessKeyChainCandidate,
    now: Date,
): { kind: AccessCertificateKind; validity: number } {
    const leaf = parseLeaf(candidate.activeCertificate);
    const valid =
        leaf !== undefined &&
        new Date(leaf.validFrom) <= now &&
        now <= new Date(leaf.validTo);
    return { kind: accessCertificateKind(candidate), validity: valid ? 0 : 1 };
}

function parseLeaf(pem: string): X509Certificate | undefined {
    const leaf =
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(
            pem,
        )?.[0];
    if (!leaf) return undefined;
    try {
        return new X509Certificate(leaf);
    } catch {
        return undefined;
    }
}

/**
 * Same issuer as subject, as the self-signed certificate of a new standalone
 * key chain has. `checkIssued` is not used: it also checks the key usage, and
 * a self-signed leaf without `keyCertSign` would count as externally issued.
 */
function isSelfSigned(certificate: X509Certificate): boolean {
    return certificate.issuer === certificate.subject;
}

function compareIds(a: string, b: string): number {
    if (a < b) return -1;
    return a > b ? 1 : 0;
}
