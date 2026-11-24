import { createHash } from "node:crypto";
import { importJWK } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    type KmsSigningAlg,
    signingAlgSpec,
} from "../../domain/signing-algs.js";
import { Pkcs11KmsAdapter } from "./pkcs11-kms.adapter.js";

/** What the fake token was asked to do, and how it answers. */
const token = vi.hoisted(() => ({
    /** CKA_EC_PARAMS of each C_GenerateKeyPair call. */
    ecParams: [] as Buffer[],
    /** Data passed to C_Sign, and the size of the output buffer. */
    signCalls: [] as { data: Buffer; outputLength: number }[],
    /** Return CKA_EC_POINT without the DER OCTET STRING wrapper. */
    unwrappedPoint: false,
    /** Generate keys on this curve, whatever CKA_EC_PARAMS names. */
    curveOverride: undefined as string | undefined,
    /** Calls that end something on the token, in order. */
    ended: [] as string[],
    /** Make C_OpenSession fail. */
    failOpen: false,
    /** Make C_Login fail. */
    failLogin: false,
}));

// Constants as in the PKCS#11 specification; the adapter only passes them on.
const CK = vi.hoisted(() => ({
    CKF_RW_SESSION: 0x2,
    CKF_SERIAL_SESSION: 0x4,
    CKU_USER: 1,
    CKA_CLASS: 0x0,
    CKA_TOKEN: 0x1,
    CKA_PRIVATE: 0x2,
    CKA_LABEL: 0x3,
    CKA_KEY_TYPE: 0x100,
    CKA_ID: 0x102,
    CKA_SENSITIVE: 0x103,
    CKA_SIGN: 0x108,
    CKA_VERIFY: 0x10a,
    CKA_EXTRACTABLE: 0x162,
    CKA_EC_PARAMS: 0x180,
    CKA_EC_POINT: 0x181,
    CKO_PUBLIC_KEY: 2,
    CKO_PRIVATE_KEY: 3,
    CKK_EC: 3,
    CKM_EC_KEY_PAIR_GEN: 0x1040,
    CKM_ECDSA: 0x1041,
}));

/** DER-encoded named-curve OIDs, written out independently of signing-algs.ts. */
const EC_PARAMS: Record<KmsSigningAlg, string> = {
    // 1.2.840.10045.3.1.7
    ES256: "06082a8648ce3d030107",
    // 1.3.132.0.34
    ES384: "06052b81040022",
    // 1.3.132.0.35
    ES512: "06052b81040023",
};

vi.mock("pkcs11js", async () => {
    const { p256, p384, p521 } = await import("@noble/curves/nist.js");
    const curves = {
        "06082a8648ce3d030107": { name: "P-256", curve: p256 },
        "06052b81040022": { name: "P-384", curve: p384 },
        "06052b81040023": { name: "P-521", curve: p521 },
    } as const;
    type Curve = (typeof curves)[keyof typeof curves];
    const byName = (name: string) =>
        Object.values(curves).find((c) => c.name === name)!;

    /** A software token that keeps its objects in memory. */
    class FakePkcs11 {
        private readonly objects = new Map<
            string,
            {
                klass: number;
                label: string;
                curve: Curve;
                secretKey: Uint8Array;
            }
        >();
        private search?: { klass: number; label: string };
        private signKey?: string;

        load() {}
        C_Initialize() {}
        C_Finalize() {
            token.ended.push("C_Finalize");
        }
        C_GetSlotList() {
            return [Buffer.from("slot-0")];
        }
        C_GetTokenInfo() {
            return { label: "fake" };
        }
        C_OpenSession() {
            if (token.failOpen) throw new Error("CKR_TOKEN_NOT_PRESENT");
            return Buffer.from("session");
        }
        C_CloseSession(session: Buffer) {
            token.ended.push(`C_CloseSession:${session.toString()}`);
        }
        C_Login() {
            if (token.failLogin) throw new Error("CKR_PIN_INCORRECT");
        }
        C_Logout() {
            token.ended.push("C_Logout");
        }

        C_GenerateKeyPair(
            _session: Buffer,
            mechanism: { mechanism: number },
            publicTemplate: { type: number; value: unknown }[],
            privateTemplate: { type: number; value: unknown }[],
        ) {
            if (mechanism.mechanism !== CK.CKM_EC_KEY_PAIR_GEN) {
                throw new Error("CKR_MECHANISM_INVALID");
            }
            const attr = (
                template: { type: number; value: unknown }[],
                type: number,
            ) => template.find((a) => a.type === type)?.value;
            const ecParams = attr(publicTemplate, CK.CKA_EC_PARAMS) as Buffer;
            token.ecParams.push(ecParams);
            const curve = token.curveOverride
                ? byName(token.curveOverride)
                : curves[ecParams.toString("hex") as keyof typeof curves];
            if (!curve) throw new Error("CKR_CURVE_NOT_SUPPORTED");
            const secretKey = curve.curve.utils.randomSecretKey();
            const label = attr(privateTemplate, CK.CKA_LABEL) as string;
            const handle = (klass: number) => {
                const id = `${klass}:${label}`;
                this.objects.set(id, { klass, label, curve, secretKey });
                return Buffer.from(id);
            };
            return {
                publicKey: handle(CK.CKO_PUBLIC_KEY),
                privateKey: handle(CK.CKO_PRIVATE_KEY),
            };
        }

        C_FindObjectsInit(
            _session: Buffer,
            template: { type: number; value: unknown }[],
        ) {
            this.search = {
                klass: template.find((a) => a.type === CK.CKA_CLASS)!
                    .value as number,
                label: template.find((a) => a.type === CK.CKA_LABEL)!
                    .value as string,
            };
        }
        C_FindObjects() {
            const id = `${this.search!.klass}:${this.search!.label}`;
            return this.objects.has(id) ? Buffer.from(id) : null;
        }
        C_FindObjectsFinal() {
            this.search = undefined;
        }

        C_GetAttributeValue(
            _session: Buffer,
            handle: Buffer,
            template: { type: number }[],
        ) {
            const object = this.objects.get(handle.toString())!;
            if (template[0].type !== CK.CKA_EC_POINT) {
                throw new Error("CKR_ATTRIBUTE_TYPE_INVALID");
            }
            const point = Buffer.from(
                object.curve.curve.getPublicKey(object.secretKey, false),
            );
            if (token.unwrappedPoint) return [{ ...template[0], value: point }];
            // DER OCTET STRING; a P-521 point (133 bytes) needs a long-form length.
            const length =
                point.length < 0x80
                    ? Buffer.from([point.length])
                    : Buffer.from([0x81, point.length]);
            return [
                {
                    ...template[0],
                    value: Buffer.concat([Buffer.from([0x04]), length, point]),
                },
            ];
        }

        C_SignInit(
            _session: Buffer,
            mechanism: { mechanism: number },
            key: Buffer,
        ) {
            if (mechanism.mechanism !== CK.CKM_ECDSA) {
                throw new Error("CKR_MECHANISM_INVALID");
            }
            this.signKey = key.toString();
        }
        C_Sign(_session: Buffer, data: Buffer, output: Buffer) {
            token.signCalls.push({ data, outputLength: output.length });
            const object = this.objects.get(this.signKey!)!;
            // CKM_ECDSA signs the given hash as it is.
            return Buffer.from(
                object.curve.curve.sign(data, object.secretKey, {
                    prehash: false,
                }),
            );
        }
        C_DestroyObject(_session: Buffer, handle: Buffer) {
            this.objects.delete(handle.toString());
        }
    }

    return { ...CK, PKCS11: FakePkcs11 };
});

function createAdapter(algorithms?: KmsSigningAlg[]) {
    return new Pkcs11KmsAdapter({
        providerId: "hsm",
        library: "/usr/lib/fake-pkcs11.so",
        slot: 0,
        pin: "1234",
        algorithms: algorithms && { algorithms },
    });
}

describe("Pkcs11KmsAdapter curves", () => {
    beforeEach(() => {
        token.ecParams.length = 0;
        token.signCalls.length = 0;
        token.unwrappedPoint = false;
        token.curveOverride = undefined;
        token.ended.length = 0;
    });

    it("offers only ES256 for new keys unless kms.json allows more", () => {
        expect(createAdapter().capabilities).toMatchObject({
            supportedAlgs: ["ES256"],
            defaultAlg: "ES256",
        });
        expect(
            createAdapter(["ES256", "ES384", "ES512"]).capabilities
                .supportedAlgs,
        ).toEqual(["ES256", "ES384", "ES512"]);
    });

    it.each([
        ["ES256", false],
        ["ES384", false],
        ["ES512", false],
        ["ES512", true],
    ] as const)(
        "generates %s keys (unwrapped EC point: %s) and signs with the matching hash",
        async (alg, unwrappedPoint) => {
            token.unwrappedPoint = unwrappedPoint;
            const adapter = createAdapter(["ES256", "ES384", "ES512"]);
            const spec = signingAlgSpec(alg);

            const { ref } = await adapter.generateKey({ kid: "k", alg });

            expect(token.ecParams[0].toString("hex")).toBe(EC_PARAMS[alg]);
            expect(ref).toMatchObject({ alg, externalKeyId: "k" });
            expect(ref.publicJwk).toMatchObject({ kty: "EC", crv: spec.crv });
            expect(Buffer.from(ref.publicJwk.x!, "base64url")).toHaveLength(
                spec.coordinateSize,
            );

            const data = new TextEncoder().encode("payload");
            const signature = await adapter.sign(ref, data);

            expect(token.signCalls).toEqual([
                {
                    data: createHash(spec.nodeHash).update(data).digest(),
                    outputLength: spec.coordinateSize * 2,
                },
            ]);
            expect(signature).toHaveLength(spec.coordinateSize * 2);
            const publicKey = (await importJWK(
                ref.publicJwk,
                alg,
            )) as CryptoKey;
            await expect(
                globalThis.crypto.subtle.verify(
                    { name: "ECDSA", hash: spec.hash },
                    publicKey,
                    signature as BufferSource,
                    data as BufferSource,
                ),
            ).resolves.toBe(true);
        },
    );

    it("generates the default algorithm when none is requested", async () => {
        const { ref } = await createAdapter().generateKey({ kid: "k" });
        expect(token.ecParams[0].toString("hex")).toBe(EC_PARAMS.ES256);
        expect(ref.publicJwk.crv).toBe("P-256");
    });

    it("rejects a token key on another curve than requested", async () => {
        token.curveOverride = "P-256";
        await expect(
            createAdapter(["ES384"]).generateKey({ kid: "k", alg: "ES384" }),
        ).rejects.toThrow(/unexpected EC point encoding for P-384/);
    });
});

describe("Pkcs11KmsAdapter dispose", () => {
    beforeEach(() => {
        token.ended.length = 0;
    });

    it("closes its session only: login and library belong to the process", async () => {
        const adapter = createAdapter();
        await adapter.generateKey({ kid: "k" });

        await adapter.dispose();

        expect(token.ended).toEqual(["C_CloseSession:session"]);
    });

    it("refuses further use instead of opening a new session", async () => {
        const adapter = createAdapter();
        const { ref } = await adapter.generateKey({ kid: "k" });
        await adapter.dispose();

        await expect(adapter.sign(ref, new Uint8Array(1))).rejects.toThrow(
            /session was closed/,
        );
        await adapter.dispose();
        expect(token.ended).toEqual(["C_CloseSession:session"]);
    });

    it("closes a session that was still being opened", async () => {
        const adapter = createAdapter();
        const pending = adapter.generateKey({ kid: "k" });

        await adapter.dispose();

        // The operation that was overtaken is refused, not left half done
        // on a closed session.
        await expect(pending).rejects.toThrow(/session was closed/);
        expect(token.ended).toEqual(["C_CloseSession:session"]);
    });

    it("has nothing to close when the session could not be opened", async () => {
        token.failOpen = true;
        try {
            const adapter = createAdapter();
            await expect(adapter.generateKey({ kid: "k" })).rejects.toThrow(
                "CKR_TOKEN_NOT_PRESENT",
            );

            await expect(adapter.dispose()).resolves.toBeUndefined();
            expect(token.ended).toEqual([]);
        } finally {
            token.failOpen = false;
        }
    });

    it("closes a session whose login fails, which nothing else would close", async () => {
        token.failLogin = true;
        try {
            const adapter = createAdapter();
            await expect(adapter.generateKey({ kid: "k" })).rejects.toThrow(
                "CKR_PIN_INCORRECT",
            );
            expect(token.ended).toEqual(["C_CloseSession:session"]);

            await adapter.dispose();
            expect(token.ended).toEqual(["C_CloseSession:session"]);
        } finally {
            token.failLogin = false;
        }
    });

    it("has nothing to close before the first use", async () => {
        await createAdapter().dispose();

        expect(token.ended).toEqual([]);
    });
});
