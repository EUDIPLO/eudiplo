import { createHash } from "node:crypto";
import { Logger, NotImplementedException } from "@nestjs/common";
import type { JWK } from "jose";
import { fileAccessHint } from "../../../../shared/utils/file-access-hint.util.js";
import {
    assertKmsSigningAlg,
    externalAlgorithmPolicy,
    KMS_SIGNING_ALGS,
    type KmsAlgorithmPolicy,
    resolveAlgorithmCapabilities,
    signingAlgSpec,
} from "../../domain/signing-algs.js";
import type { KmsProviderType } from "../../dto/kms-config.dto.js";
import type {
    KmsAdapter,
    KmsAdapterCapabilities,
    KmsHealthResult,
    KmsKeyMaterial,
    KmsKeyRef,
    KmsSigningAlg,
} from "../kms-adapter.js";
import { PublicJwkCache } from "../public-jwk-cache.js";

export interface Pkcs11AdapterConfig {
    providerId: string;
    /** Absolute path to the PKCS#11 module library (.so/.dll/.dylib). */
    library: string;
    /**
     * Slot selection. Either the numeric slot id, or a token label that
     * will be resolved against the slot list at initialisation time.
     */
    slot: number | string;
    /** User PIN. */
    pin: string;
    /**
     * Optional read-only mode. Defaults to false (RW session). Set to
     * true if the adapter only needs to sign with existing keys.
     */
    readOnly?: boolean;
    /**
     * Algorithms allowed for new keys (from `kms.json`). Restrict them to
     * the curves the token supports.
     */
    algorithms?: KmsAlgorithmPolicy;
}

// Minimal subset of the pkcs11js surface we touch. Avoids a hard
// compile-time dependency on the optional native module.
interface Pkcs11Module {
    PKCS11: new () => Pkcs11Instance;
    [constant: string]: unknown;
}

interface Pkcs11Instance {
    load(path: string): void;
    C_Initialize(): void;
    C_Finalize(): void;
    C_GetSlotList(tokenPresent: boolean): Buffer[];
    C_GetTokenInfo(slot: Buffer): { label: string };
    C_OpenSession(slot: Buffer, flags: number): Buffer;
    C_CloseSession(session: Buffer): void;
    C_Login(session: Buffer, userType: number, pin: string): void;
    C_Logout(session: Buffer): void;
    C_GenerateKeyPair(
        session: Buffer,
        mechanism: { mechanism: number },
        publicTemplate: Pkcs11Attribute[],
        privateTemplate: Pkcs11Attribute[],
    ): { publicKey: Buffer; privateKey: Buffer };
    C_FindObjectsInit(session: Buffer, template: Pkcs11Attribute[]): void;
    C_FindObjects(session: Buffer): Buffer | null;
    C_FindObjectsFinal(session: Buffer): void;
    C_GetAttributeValue(
        session: Buffer,
        object: Buffer,
        template: Pkcs11Attribute[],
    ): Pkcs11Attribute[];
    C_SignInit(
        session: Buffer,
        mechanism: { mechanism: number },
        key: Buffer,
    ): void;
    C_Sign(session: Buffer, data: Buffer, output: Buffer): Buffer;
    C_DestroyObject(session: Buffer, object: Buffer): void;
}

interface Pkcs11Attribute {
    type: number;
    value: unknown;
}

interface Pkcs11Constants {
    CKF_RW_SESSION: number;
    CKF_SERIAL_SESSION: number;
    CKU_USER: number;
    CKA_CLASS: number;
    CKA_KEY_TYPE: number;
    CKA_LABEL: number;
    CKA_ID: number;
    CKA_TOKEN: number;
    CKA_PRIVATE: number;
    CKA_SIGN: number;
    CKA_VERIFY: number;
    CKA_SENSITIVE: number;
    CKA_EXTRACTABLE: number;
    CKA_EC_PARAMS: number;
    CKA_EC_POINT: number;
    CKO_PUBLIC_KEY: number;
    CKO_PRIVATE_KEY: number;
    CKK_EC: number;
    CKM_EC_KEY_PAIR_GEN: number;
    CKM_ECDSA: number;
}

/**
 * PKCS#11 KMS adapter.
 *
 * Generates ECDSA P-256, P-384 or P-521 keys directly inside the HSM/token via the
 * PKCS#11 interface and routes all signing through `C_Sign`. Private
 * key material is created with `CKA_SENSITIVE=true` and
 * `CKA_EXTRACTABLE=false` so it never leaves the device.
 *
 * Keys are addressed by their PKCS#11 `CKA_LABEL`, which we set to the
 * caller-supplied `kid`. The label doubles as the `externalKeyId` on
 * the resulting {@link KmsKeyRef}.
 *
 * The native module `pkcs11js` is loaded lazily on first use so
 * deployments that don't configure a PKCS#11 provider don't need the
 * library installed or the platform toolchain to build it.
 */
export class Pkcs11KmsAdapter implements KmsAdapter {
    private readonly logger = new Logger(Pkcs11KmsAdapter.name);

    readonly providerId: string;
    readonly type: KmsProviderType = "pkcs11";
    readonly capabilities: KmsAdapterCapabilities;

    private readonly config: Pkcs11AdapterConfig;
    private readonly jwkCache = new PublicJwkCache();

    private pkcs11?: Pkcs11Instance;
    private constants?: Pkcs11Constants;
    private session?: Buffer;
    private initPromise?: Promise<void>;
    private disposed = false;

    constructor(config: Pkcs11AdapterConfig) {
        this.providerId = config.providerId;
        this.config = config;
        this.capabilities = {
            canCreate: true,
            canImport: false,
            canDelete: true,
            // Tokens differ in the curves they support: the default only, unless configured.
            ...resolveAlgorithmCapabilities(
                KMS_SIGNING_ALGS,
                externalAlgorithmPolicy(config.algorithms),
            ),
        };
    }

    async generateKey(opts: {
        kid: string;
        alg?: KmsSigningAlg;
    }): Promise<KmsKeyMaterial> {
        // Not limited to capabilities.supportedAlgs: rotation keeps the
        // algorithm of an existing key chain.
        const alg = opts.alg ?? this.capabilities.defaultAlg;
        assertKmsSigningAlg(alg, `Pkcs11KmsAdapter[${this.providerId}]`);
        const { p11, c, session } = await this.ensureSession();

        const idBuf = Buffer.from(opts.kid, "utf8");
        const publicTemplate: Pkcs11Attribute[] = [
            { type: c.CKA_CLASS, value: c.CKO_PUBLIC_KEY },
            { type: c.CKA_KEY_TYPE, value: c.CKK_EC },
            { type: c.CKA_LABEL, value: opts.kid },
            { type: c.CKA_ID, value: idBuf },
            { type: c.CKA_TOKEN, value: true },
            { type: c.CKA_VERIFY, value: true },
            {
                type: c.CKA_EC_PARAMS,
                value: Buffer.from(signingAlgSpec(alg).curveOidDer),
            },
        ];
        const privateTemplate: Pkcs11Attribute[] = [
            { type: c.CKA_CLASS, value: c.CKO_PRIVATE_KEY },
            { type: c.CKA_KEY_TYPE, value: c.CKK_EC },
            { type: c.CKA_LABEL, value: opts.kid },
            { type: c.CKA_ID, value: idBuf },
            { type: c.CKA_TOKEN, value: true },
            { type: c.CKA_PRIVATE, value: true },
            { type: c.CKA_SIGN, value: true },
            { type: c.CKA_SENSITIVE, value: true },
            { type: c.CKA_EXTRACTABLE, value: false },
        ];

        const keys = p11.C_GenerateKeyPair(
            session,
            { mechanism: c.CKM_EC_KEY_PAIR_GEN },
            publicTemplate,
            privateTemplate,
        );

        const publicJwk = await this.readPublicJwk(
            opts.kid,
            alg,
            keys.publicKey,
        );
        this.jwkCache.set(opts.kid, publicJwk);
        return { ref: { externalKeyId: opts.kid, publicJwk, alg } };
    }

    importKey(_opts: {
        kid: string;
        privateJwk: JWK;
        alg?: KmsSigningAlg;
    }): Promise<KmsKeyMaterial> {
        throw new NotImplementedException(
            `Pkcs11KmsAdapter[${this.providerId}]: importKey is not supported — generate keys inside the HSM`,
        );
    }

    async sign(
        ref: KmsKeyRef,
        data: Uint8Array,
        alg?: KmsSigningAlg,
    ): Promise<Uint8Array> {
        if (!ref.externalKeyId) {
            throw new Error(
                `Pkcs11KmsAdapter[${this.providerId}]: missing externalKeyId`,
            );
        }
        const signAlg = alg ?? ref.alg;
        assertKmsSigningAlg(signAlg, `Pkcs11KmsAdapter[${this.providerId}]`);
        const spec = signingAlgSpec(signAlg);

        const { p11, c, session } = await this.ensureSession();
        const handle = this.findObject(
            p11,
            c,
            session,
            c.CKO_PRIVATE_KEY,
            ref.externalKeyId,
        );
        if (!handle) {
            throw new Error(
                `Pkcs11KmsAdapter[${this.providerId}]: private key '${ref.externalKeyId}' not found`,
            );
        }

        const digest = createHash(spec.nodeHash).update(data).digest();
        p11.C_SignInit(session, { mechanism: c.CKM_ECDSA }, handle);
        // CKM_ECDSA returns the raw r || s, two coordinates long.
        const sig = p11.C_Sign(
            session,
            digest,
            Buffer.alloc(spec.coordinateSize * 2),
        );
        return new Uint8Array(sig);
    }

    async deleteKey(ref: KmsKeyRef): Promise<void> {
        if (!ref.externalKeyId) return;
        this.jwkCache.invalidate(ref.externalKeyId);
        const { p11, c, session } = await this.ensureSession();
        for (const klass of [c.CKO_PRIVATE_KEY, c.CKO_PUBLIC_KEY]) {
            const handle = this.findObject(
                p11,
                c,
                session,
                klass,
                ref.externalKeyId,
            );
            if (handle) {
                try {
                    p11.C_DestroyObject(session, handle);
                } catch (err) {
                    this.logger.warn(
                        `Failed to destroy PKCS#11 object ${ref.externalKeyId}: ${String(err)}`,
                    );
                }
            }
        }
    }

    async health(): Promise<KmsHealthResult> {
        const start = Date.now();
        try {
            await this.ensureSession();
            return { ok: true, latencyMs: Date.now() - start };
        } catch (err) {
            return {
                ok: false,
                latencyMs: Date.now() - start,
                error: String(err),
            };
        }
    }

    /**
     * Close the session. Not C_Logout or C_Finalize: the login state and the
     * library belong to every session of this process on the token, also
     * those of other adapters.
     */
    async dispose(): Promise<void> {
        this.disposed = true;
        // A session that is being opened is closed once it is there.
        await this.initPromise?.catch(() => undefined);
        const { pkcs11, session } = this;
        this.session = undefined;
        this.jwkCache.clear();
        if (pkcs11 && session) {
            pkcs11.C_CloseSession(session);
        }
    }

    private async ensureSession(): Promise<{
        p11: Pkcs11Instance;
        c: Pkcs11Constants;
        session: Buffer;
    }> {
        if (this.disposed) {
            throw new Error(
                `Pkcs11KmsAdapter[${this.providerId}]: this session was closed, retry the operation`,
            );
        }
        this.initPromise ??= this.initialise();
        await this.initPromise;
        if (!this.pkcs11 || !this.constants || !this.session) {
            throw new Error(
                `Pkcs11KmsAdapter[${this.providerId}]: not initialised`,
            );
        }
        return {
            p11: this.pkcs11,
            c: this.constants,
            session: this.session,
        };
    }

    private async initialise(): Promise<void> {
        const mod = await loadPkcs11();
        const c = toConstants(mod);
        const p11 = new mod.PKCS11();
        try {
            p11.load(this.config.library);
        } catch (error) {
            const hint = fileAccessHint(error, this.config.library);
            if (!hint) throw error;
            throw new Error(
                `Pkcs11KmsAdapter[${this.providerId}]: library ${this.config.library} cannot be loaded: ${(error as Error).message}.${hint}`,
                { cause: error },
            );
        }
        p11.C_Initialize();

        const slots = p11.C_GetSlotList(true);
        const slot = this.selectSlot(p11, slots);

        const flags =
            c.CKF_SERIAL_SESSION |
            (this.config.readOnly ? 0 : c.CKF_RW_SESSION);
        const session = p11.C_OpenSession(slot, flags);
        try {
            p11.C_Login(session, c.CKU_USER, this.config.pin);
        } catch (err) {
            // Nothing else knows this session, so nothing else would close it.
            p11.C_CloseSession(session);
            throw err;
        }

        this.pkcs11 = p11;
        this.constants = c;
        this.session = session;
        this.logger.log(
            `Pkcs11KmsAdapter[${this.providerId}] initialised on ${this.config.library}`,
        );
    }

    private selectSlot(p11: Pkcs11Instance, slots: Buffer[]): Buffer {
        if (slots.length === 0) {
            throw new Error(
                `Pkcs11KmsAdapter[${this.providerId}]: no slots with a token present`,
            );
        }
        if (typeof this.config.slot === "number") {
            const index = this.config.slot;
            const slot = slots[index];
            if (!slot) {
                throw new Error(
                    `Pkcs11KmsAdapter[${this.providerId}]: slot index ${index} out of range (0..${slots.length - 1})`,
                );
            }
            return slot;
        }
        const wantedLabel = this.config.slot.trim();
        for (const slot of slots) {
            const info = p11.C_GetTokenInfo(slot);
            if (info.label.trim() === wantedLabel) return slot;
        }
        throw new Error(
            `Pkcs11KmsAdapter[${this.providerId}]: no slot with token label '${wantedLabel}'`,
        );
    }

    private findObject(
        p11: Pkcs11Instance,
        c: Pkcs11Constants,
        session: Buffer,
        keyClass: number,
        label: string,
    ): Buffer | null {
        p11.C_FindObjectsInit(session, [
            { type: c.CKA_CLASS, value: keyClass },
            { type: c.CKA_LABEL, value: label },
        ]);
        try {
            return p11.C_FindObjects(session);
        } finally {
            p11.C_FindObjectsFinal(session);
        }
    }

    private async readPublicJwk(
        kid: string,
        alg: KmsSigningAlg,
        handle: Buffer,
    ): Promise<JWK> {
        const { p11, c, session } = await this.ensureSession();
        const attrs = p11.C_GetAttributeValue(session, handle, [
            { type: c.CKA_EC_POINT, value: null },
        ]);
        const raw = attrs[0]?.value;
        if (!Buffer.isBuffer(raw)) {
            throw new TypeError(
                `Pkcs11KmsAdapter[${this.providerId}]: CKA_EC_POINT returned non-buffer value`,
            );
        }
        const { crv, coordinateSize } = signingAlgSpec(alg);
        const ecPoint = unwrapEcPoint(raw);
        if (ecPoint.length !== 1 + 2 * coordinateSize || ecPoint[0] !== 0x04) {
            throw new Error(
                `Pkcs11KmsAdapter[${this.providerId}]: unexpected EC point encoding for ${crv} (length ${ecPoint.length})`,
            );
        }
        const jwk: JWK = {
            kty: "EC",
            crv,
            x: ecPoint.subarray(1, 1 + coordinateSize).toString("base64url"),
            y: ecPoint.subarray(1 + coordinateSize).toString("base64url"),
            kid,
            alg,
        };
        // Rejects points that are not on the curve.
        await globalThis.crypto.subtle.importKey(
            "jwk",
            { kty: jwk.kty, crv, x: jwk.x, y: jwk.y },
            { name: "ECDSA", namedCurve: crv },
            true,
            ["verify"],
        );
        return jwk;
    }
}

/**
 * CKA_EC_POINT is specified as a DER-encoded OCTET STRING wrapping the
 * raw ECPoint. Some HSM vendors return the unwrapped ECPoint directly,
 * so we accept both.
 */
function unwrapEcPoint(raw: Buffer): Buffer {
    if (raw.length >= 2 && raw[0] === 0x04 && raw[1] === raw.length - 2) {
        return raw.subarray(2);
    }
    // Long-form DER length (P-521 points are 133 bytes).
    if (raw.length >= 3 && raw[0] === 0x04 && raw[1] === 0x81) {
        return raw.subarray(3);
    }
    return raw;
}

function toConstants(mod: Pkcs11Module): Pkcs11Constants {
    return mod as unknown as Pkcs11Constants;
}

let pkcs11ModulePromise: Promise<Pkcs11Module> | undefined;

async function loadPkcs11(): Promise<Pkcs11Module> {
    pkcs11ModulePromise ??= (async () => {
        try {
            const mod = (await import("pkcs11js")) as unknown as
                | Pkcs11Module
                | { default: Pkcs11Module };
            return "PKCS11" in mod ? mod : mod.default;
        } catch (err) {
            throw new Error(
                `pkcs11js is not installed. Install it with 'pnpm add pkcs11js' in apps/backend before configuring a pkcs11 KMS provider. Original error: ${String(err)}`,
            );
        }
    })();
    return pkcs11ModulePromise;
}
