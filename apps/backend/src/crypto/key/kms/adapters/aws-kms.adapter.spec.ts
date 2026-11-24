import {
    createPublicKey,
    generateKeyPairSync,
    type KeyObject,
    sign,
} from "node:crypto";
import {
    CreateKeyCommand,
    GetPublicKeyCommand,
    type KMSClient,
    SignCommand,
} from "@aws-sdk/client-kms";
import { importJWK } from "jose";
import { describe, expect, it, vi } from "vitest";
import {
    type KmsSigningAlg,
    signingAlgSpec,
} from "../../domain/signing-algs.js";
import { AwsKmsAdapter } from "./aws-kms.adapter.js";

/** AWS names, written out independently of the adapter's tables. */
const AWS: Record<
    KmsSigningAlg,
    { keySpec: string; signingAlgorithm: string; nodeCurve: string }
> = {
    ES256: {
        keySpec: "ECC_NIST_P256",
        signingAlgorithm: "ECDSA_SHA_256",
        nodeCurve: "prime256v1",
    },
    ES384: {
        keySpec: "ECC_NIST_P384",
        signingAlgorithm: "ECDSA_SHA_384",
        nodeCurve: "secp384r1",
    },
    ES512: {
        keySpec: "ECC_NIST_P521",
        signingAlgorithm: "ECDSA_SHA_512",
        nodeCurve: "secp521r1",
    },
};

/**
 * An in-memory stand-in for the AWS KMS client: CreateKey makes a key of the
 * requested KeySpec, and Sign hashes the RAW message and returns a DER
 * ECDSA-Sig-Value, as AWS does.
 */
function createFakeKms() {
    const keys = new Map<string, KeyObject>();
    const commands: { command: string; input: Record<string, any> }[] = [];
    const send = async (command: { input: Record<string, any> }) => {
        const { input } = command;
        commands.push({ command: command.constructor.name, input });
        if (command instanceof CreateKeyCommand) {
            const aws = Object.values(AWS).find(
                (entry) => entry.keySpec === input.KeySpec,
            );
            if (!aws) throw new Error(`Unsupported KeySpec ${input.KeySpec}`);
            const keyId = `key-${keys.size + 1}`;
            keys.set(
                keyId,
                generateKeyPairSync("ec", { namedCurve: aws.nodeCurve })
                    .privateKey,
            );
            return { KeyMetadata: { KeyId: keyId } };
        }
        if (command instanceof GetPublicKeyCommand) {
            return {
                PublicKey: new Uint8Array(
                    createPublicKey(keys.get(input.KeyId)!).export({
                        format: "der",
                        type: "spki",
                    }),
                ),
            };
        }
        if (command instanceof SignCommand) {
            const alg = Object.entries(AWS).find(
                ([, entry]) =>
                    entry.signingAlgorithm === input.SigningAlgorithm,
            )?.[0] as KmsSigningAlg | undefined;
            if (!alg) {
                throw new Error(
                    `Unsupported algorithm ${input.SigningAlgorithm}`,
                );
            }
            return {
                Signature: new Uint8Array(
                    sign(
                        signingAlgSpec(alg).nodeHash,
                        input.Message,
                        keys.get(input.KeyId)!,
                    ),
                ),
            };
        }
        throw new Error(`Unexpected command ${command.constructor.name}`);
    };
    return { client: { send } as unknown as KMSClient, commands };
}

function createAdapter(client: KMSClient) {
    const adapter = new AwsKmsAdapter({
        providerId: "aws",
        region: "eu-central-1",
    });
    // Skip the lazy import of the real client.
    (
        adapter as unknown as { clientPromise: Promise<KMSClient> }
    ).clientPromise = Promise.resolve(client);
    return adapter;
}

describe("AwsKmsAdapter curves", () => {
    it("offers ES256, ES384 and ES512 with ES256 as default", () => {
        expect(
            createAdapter(createFakeKms().client).capabilities,
        ).toMatchObject({
            supportedAlgs: ["ES256", "ES384", "ES512"],
            defaultAlg: "ES256",
        });
    });

    it.each(["ES256", "ES384", "ES512"] as const)(
        "creates %s keys with the matching KeySpec and SigningAlgorithm",
        async (alg) => {
            const { client, commands } = createFakeKms();
            const adapter = createAdapter(client);
            const spec = signingAlgSpec(alg);

            const { ref } = await adapter.generateKey({ kid: "k", alg });

            expect(commands[0]).toMatchObject({
                command: "CreateKeyCommand",
                input: { KeyUsage: "SIGN_VERIFY", KeySpec: AWS[alg].keySpec },
            });
            expect(ref).toMatchObject({ alg, externalKeyId: "key-1" });
            expect(ref.publicJwk).toMatchObject({
                kty: "EC",
                crv: spec.crv,
                kid: "k",
                alg,
            });

            const data = new TextEncoder().encode("payload");
            const signature = await adapter.sign(ref, data);

            expect(commands.at(-1)).toMatchObject({
                command: "SignCommand",
                input: {
                    KeyId: "key-1",
                    MessageType: "RAW",
                    SigningAlgorithm: AWS[alg].signingAlgorithm,
                },
            });
            // The DER signature is re-encoded as raw r || s.
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

    it("creates the default algorithm when none is requested", async () => {
        const { client, commands } = createFakeKms();
        const { ref } = await createAdapter(client).generateKey({ kid: "k" });
        expect(commands[0].input.KeySpec).toBe("ECC_NIST_P256");
        expect(ref.alg).toBe("ES256");
    });
});

describe("AwsKmsAdapter dispose", () => {
    it("closes the connections of a client it created", async () => {
        const { client } = createFakeKms();
        const destroy = vi.fn();
        const adapter = createAdapter({ ...client, destroy } as KMSClient);

        await adapter.dispose();

        expect(destroy).toHaveBeenCalledTimes(1);
    });

    it("has nothing to close when the client could not be created", async () => {
        const adapter = new AwsKmsAdapter({
            providerId: "aws",
            region: "eu-central-1",
        });
        (
            adapter as unknown as { clientPromise: Promise<never> }
        ).clientPromise = Promise.reject(new Error("no client"));

        await expect(adapter.dispose()).resolves.toBeUndefined();
    });

    it("creates no client only to close it", async () => {
        const adapter = new AwsKmsAdapter({
            providerId: "aws",
            region: "eu-central-1",
        });

        await adapter.dispose();

        expect(
            (adapter as unknown as { clientPromise?: unknown }).clientPromise,
        ).toBeUndefined();
    });
});
