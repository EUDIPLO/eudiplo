import { createPrivateKey, type KeyObject, X509Certificate } from "node:crypto";
import {
    type ImportedKeyChainType,
    importedKeyChainType,
} from "../../crypto/key/domain/key-chain-import-type.js";
import type { KeyChainEntity } from "../../crypto/key/entities/key-chain.entity.js";
import { importedRotationIntervals } from "../../crypto/key/key-chain-import-rotation.js";

type Spec = Record<string, any>;

interface RotationPolicy {
    enabled: boolean;
    intervalDays?: number;
    certValidityDays?: number;
}

interface InternalChainProblem {
    code: string;
    path: string;
    message: string;
}

/**
 * A `private-jwk` key source with `activeJwk` describes an internal chain as
 * stored: `jwk` is the root CA key with its certificate in `crt`, `activeJwk`
 * the signing key with its certificate in `activeCertificate`. Applying it
 * saves both pairs in the database as they are. A private key without
 * `activeJwk` goes through the key chain importer instead.
 */
export function isInternalChainWithPrivateKeys(spec: Spec): boolean {
    return spec.keySource?.type === "private-jwk" && !!spec.keySource.activeJwk;
}

/**
 * The KMS provider that applying a key chain document stores, so the plan
 * and apply agree: an internal chain with private keys always goes into the
 * database.
 */
export function appliedKmsProvider(spec: Spec): string | undefined {
    return isInternalChainWithPrivateKeys(spec) ? "db" : spec.kmsProvider;
}

/**
 * The KMS provider that applying a key chain document stores its keys in,
 * and those keys with their document paths. An undefined provider means the
 * tenant's default. A key source without stored keys (`regenerate`, or none)
 * has no keys.
 */
export function keyChainProviderKeys(spec: Spec): {
    provider: string | undefined;
    keys: Array<{ path: string; jwk: unknown }>;
} {
    const source = spec.keySource;
    if (source?.type === "private-jwk") {
        const keys = [{ path: "/spec/keySource/jwk", jwk: source.jwk }];
        if (isInternalChainWithPrivateKeys(spec)) {
            keys.push({
                path: "/spec/keySource/activeJwk",
                jwk: source.activeJwk,
            });
        }
        return { provider: appliedKmsProvider(spec), keys };
    }
    if (source?.type === "external-reference") {
        const keys = [
            { path: "/spec/keySource/publicJwk", jwk: source.publicJwk },
        ];
        if (source.activePublicJwk) {
            keys.push({
                path: "/spec/keySource/activePublicJwk",
                jwk: source.activePublicJwk,
            });
        }
        return { provider: source.provider, keys };
    }
    return { provider: undefined, keys: [] };
}

/** What applying an internal chain with private keys would reject or drop. */
export function internalChainProblems(spec: Spec): InternalChainProblem[] {
    const rootKey = privateKey(spec.keySource?.jwk);
    const activeKey = privateKey(spec.keySource?.activeJwk);
    const problems: Array<InternalChainProblem | undefined> = [
        spec.kmsProvider === undefined || spec.kmsProvider === "db"
            ? undefined
            : {
                  code: "INVALID_KMS_PROVIDER",
                  path: "/spec/kmsProvider",
                  message:
                      "An internal chain with private keys is stored in the database. Omit kmsProvider or set it to db.",
              },
        rootKey
            ? undefined
            : {
                  code: "INVALID_PRIVATE_KEY",
                  path: "/spec/keySource/jwk",
                  message: "keySource.jwk is not a valid private key.",
              },
        activeKey
            ? undefined
            : {
                  code: "INVALID_PRIVATE_KEY",
                  path: "/spec/keySource/activeJwk",
                  message: "keySource.activeJwk is not a valid private key.",
              },
        rootCertificateProblem(spec.crt, rootKey),
        activeCertificateProblem(spec.activeCertificate, activeKey),
    ];
    return problems.filter((problem) => problem !== undefined);
}

function rootCertificateProblem(
    crt: unknown,
    rootKey: KeyObject | undefined,
): InternalChainProblem | undefined {
    if (!Array.isArray(crt) || crt.length !== 1) {
        return {
            code: "ROOT_CERTIFICATE_REQUIRED",
            path: "/spec/crt",
            message:
                "crt must contain exactly one certificate: the root CA certificate of keySource.jwk.",
        };
    }
    const root = certificate(crt[0]);
    if (!root) {
        return {
            code: "INVALID_CERTIFICATE",
            path: "/spec/crt/0",
            message: "The root CA certificate is not a PEM certificate.",
        };
    }
    // Rotation signs new signing certificates with the root.
    if (!root.ca) {
        return {
            code: "ROOT_CERTIFICATE_NOT_CA",
            path: "/spec/crt/0",
            message:
                "The root certificate must be a CA certificate (basicConstraints CA=true).",
        };
    }
    if (rootKey && !belongsTo(root, rootKey)) {
        return {
            code: "CERTIFICATE_KEY_MISMATCH",
            path: "/spec/crt/0",
            message:
                "The root CA certificate does not belong to keySource.jwk.",
        };
    }
    return undefined;
}

function activeCertificateProblem(
    activeCertificate: unknown,
    activeKey: KeyObject | undefined,
): InternalChainProblem | undefined {
    if (!activeCertificate) {
        return {
            code: "ACTIVE_CERTIFICATE_REQUIRED",
            path: "/spec/activeCertificate",
            message: "activeCertificate is required with keySource.activeJwk.",
        };
    }
    const active = certificate(activeCertificate);
    if (!active) {
        return {
            code: "INVALID_CERTIFICATE",
            path: "/spec/activeCertificate",
            message: "activeCertificate does not start with a PEM certificate.",
        };
    }
    if (activeKey && !belongsTo(active, activeKey)) {
        return {
            code: "CERTIFICATE_KEY_MISMATCH",
            path: "/spec/activeCertificate",
            message:
                "The first certificate in activeCertificate does not belong to keySource.activeJwk.",
        };
    }
    return undefined;
}

function privateKey(jwk: unknown): KeyObject | undefined {
    try {
        return createPrivateKey({ key: jwk as JsonWebKey, format: "jwk" });
    } catch {
        return undefined;
    }
}

/** The first certificate of a PEM value. */
function certificate(value: unknown): X509Certificate | undefined {
    if (typeof value !== "string") return undefined;
    try {
        return new X509Certificate(value);
    } catch {
        return undefined;
    }
}

function belongsTo(certificate: X509Certificate, key: KeyObject): boolean {
    try {
        return certificate.checkPrivateKey(key);
    } catch {
        return false;
    }
}

/**
 * Null in a rotation value means the same as leaving it out. Earlier exports
 * wrote null for unset values; the legacy importer schema accepts only
 * omitted ones.
 */
export function withoutNullRotationValues(spec: Spec): Spec {
    if (!spec.rotationPolicy || typeof spec.rotationPolicy !== "object")
        return spec;
    const rotationPolicy = { ...spec.rotationPolicy };
    for (const key of ["intervalDays", "certValidityDays"])
        if (rotationPolicy[key] === null) delete rotationPolicy[key];
    return { ...spec, rotationPolicy };
}

/**
 * The rotation policy that applying a key chain document stores, so the plan
 * and the importers agree. The document replaces the stored policy: a value
 * it leaves out or sets to null is not set, and without a policy rotation is
 * off. A private key without `activeJwk` goes through the key chain importer,
 * which keeps the intervals only with rotation and then fills in its defaults.
 */
export function appliedRotationPolicy(spec: Spec): RotationPolicy {
    const policy = spec.rotationPolicy ?? {};
    const enabled: boolean = policy.enabled ?? false;
    const intervalDays = policy.intervalDays ?? undefined;
    const certValidityDays = policy.certValidityDays ?? undefined;
    if (
        spec.keySource?.type !== "private-jwk" ||
        isInternalChainWithPrivateKeys(spec)
    )
        return { enabled, intervalDays, certValidityDays };
    if (!enabled) return { enabled };
    return { enabled, ...importedRotationIntervals(policy) };
}

/**
 * The key chain type that a key source fixes: an active key besides the root
 * key makes an internal chain. Undefined when the document's `type` decides,
 * as for a private key without `activeJwk`.
 */
export function keySourceKeyChainType(
    spec: Spec,
): ImportedKeyChainType | undefined {
    const source = spec.keySource;
    switch (source?.type) {
        case "private-jwk":
            return isInternalChainWithPrivateKeys(spec)
                ? "internalChain"
                : undefined;
        case "external-reference":
            return source.activeExternalKeyId ? "internalChain" : "standalone";
        case "regenerate":
            return source.keyChainType;
        default:
            return undefined;
    }
}

/**
 * The key chain type that applying a key chain document creates, so the plan
 * and the importers agree. A private key without `activeJwk` goes through the
 * key chain importer; a document without key material falls back to whether
 * it has an active certificate.
 */
export function appliedKeyChainType(spec: Spec): ImportedKeyChainType {
    const fixed = keySourceKeyChainType(spec);
    if (fixed) return fixed;
    if (spec.keySource?.type === "private-jwk")
        return importedKeyChainType(spec);
    return (
        spec.type ?? (spec.activeCertificate ? "internalChain" : "standalone")
    );
}

/**
 * The columns besides key material that a key chain document replaces. An
 * unset value is null, which clears the column on save; the entity types
 * these nullable columns without null.
 */
export function keyChainSettingsColumns(
    spec: Spec,
): Pick<
    KeyChainEntity,
    | "description"
    | "rotationEnabled"
    | "rotationIntervalDays"
    | "certValidityDays"
> {
    const policy = appliedRotationPolicy(spec);
    return {
        description: spec.description ?? null,
        rotationEnabled: policy.enabled,
        rotationIntervalDays: policy.intervalDays ?? (null as any),
        certValidityDays: policy.certValidityDays ?? (null as any),
    };
}

/**
 * The spec of those columns and of the key chain type, for exports and plans;
 * unset values are left out.
 */
export function keyChainSettingsSpec(keyChain: KeyChainEntity) {
    return {
        type: keyChain.hasInternalCa() ? "internalChain" : "standalone",
        description: keyChain.description ?? undefined,
        rotationPolicy: {
            enabled: keyChain.rotationEnabled,
            intervalDays: keyChain.rotationIntervalDays ?? undefined,
            certValidityDays: keyChain.certValidityDays ?? undefined,
        },
    };
}
