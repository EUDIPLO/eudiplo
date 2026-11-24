import { webcrypto } from "node:crypto";
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
    type KmsSigningAlg,
    signingAlgSpec,
} from "../../src/crypto/key/domain/signing-algs.js";

// ---------------------------------------------------------------------------
// Minimal in-process HTTP KMS server
// Implements the HTTP provider API (docs: reference/kms-config.md) without any external
// process dependency, so the test is fast, portable, and port-conflict-free.
// ---------------------------------------------------------------------------

const subtle = webcrypto.subtle;

interface StoredKey {
    pair: webcrypto.CryptoKeyPair;
    alg: KmsSigningAlg;
}

/**
 * Behaviour switches of the mock KMS. `curveOverride` makes key generation
 * return a key on another curve than the requested algorithm's.
 */
export const mockKms: {
    curveOverride?: string;
    signCount: number;
    importCount: number;
} = {
    signCount: 0,
    importCount: 0,
};

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
}

/** The public JWK without the members only WebCrypto uses. */
async function publicJwkOf(key: webcrypto.CryptoKey): Promise<JsonWebKey> {
    const { kty, crv, x, y } = await subtle.exportKey("jwk", key);
    return { kty, crv, x, y };
}

async function kmsHandler(
    req: IncomingMessage,
    res: ServerResponse,
    keyStore: Map<string, StoredKey>,
): Promise<void> {
    const parts = (req.url ?? "/").split("/").filter(Boolean);

    try {
        // GET /health
        if (
            req.method === "GET" &&
            parts.length === 1 &&
            parts[0] === "health"
        ) {
            json(res, 200, { ok: true, keyCount: keyStore.size });
            return;
        }

        // POST /keys — generate a new ECDSA key on the curve of alg
        if (
            req.method === "POST" &&
            parts.length === 1 &&
            parts[0] === "keys"
        ) {
            const { kid, alg } = JSON.parse(await readBody(req)) as {
                kid: string;
                alg: KmsSigningAlg;
            };
            const namedCurve = mockKms.curveOverride ?? signingAlgSpec(alg).crv;
            const pair = await subtle.generateKey(
                { name: "ECDSA", namedCurve },
                true,
                ["sign", "verify"],
            );
            keyStore.set(kid, { pair, alg });
            json(res, 200, {
                publicJwk: { ...(await publicJwkOf(pair.publicKey)), kid, alg },
            });
            return;
        }

        // POST /keys/:kid/sign
        if (
            req.method === "POST" &&
            parts.length === 3 &&
            parts[0] === "keys" &&
            parts[2] === "sign"
        ) {
            const kid = parts[1];
            const stored = keyStore.get(kid);
            if (!stored) {
                json(res, 404, { error: "Key not found" });
                return;
            }
            const { data, alg } = JSON.parse(await readBody(req)) as {
                data: string;
                alg: KmsSigningAlg;
            };
            mockKms.signCount++;
            // The adapter names the key's algorithm on every request.
            if (alg !== stored.alg) {
                json(res, 400, { error: `Key ${kid} signs ${stored.alg}` });
                return;
            }
            const sigBuf = await subtle.sign(
                { name: "ECDSA", hash: signingAlgSpec(alg).hash },
                stored.pair.privateKey,
                Buffer.from(data, "base64"),
            );
            json(res, 200, {
                signature: Buffer.from(sigBuf).toString("base64url"),
            });
            return;
        }

        // POST /keys/:kid/import
        if (
            req.method === "POST" &&
            parts.length === 3 &&
            parts[0] === "keys" &&
            parts[2] === "import"
        ) {
            mockKms.importCount++;
            const kid = parts[1];
            const { privateJwk, alg } = JSON.parse(await readBody(req)) as {
                privateJwk: JsonWebKey;
                alg: KmsSigningAlg;
            };
            const namedCurve = privateJwk.crv!;
            const privateKey = await subtle.importKey(
                "jwk",
                privateJwk,
                { name: "ECDSA", namedCurve },
                true,
                ["sign"],
            );
            const pubJwk = { ...privateJwk } as JsonWebKey & { d?: string };
            delete pubJwk.d;
            const publicKey = await subtle.importKey(
                "jwk",
                pubJwk,
                { name: "ECDSA", namedCurve },
                true,
                ["verify"],
            );
            keyStore.set(kid, { pair: { privateKey, publicKey }, alg });
            json(res, 200, {
                publicJwk: { ...(await publicJwkOf(publicKey)), kid, alg },
            });
            return;
        }

        // DELETE /keys/:kid
        if (
            req.method === "DELETE" &&
            parts.length === 2 &&
            parts[0] === "keys"
        ) {
            keyStore.delete(parts[1]);
            res.writeHead(204);
            res.end();
            return;
        }

        json(res, 404, { error: "Not found" });
    } catch (err) {
        json(res, 500, { error: String(err) });
    }
}

/**
 * Start the mock on a free port. `keyIds` lists the keys it holds,
 * `publicJwk` gives the public key it holds under a name.
 */
export function startKmsServer(): Promise<{
    server: Server;
    baseUrl: string;
    keyIds: () => string[];
    publicJwk: (kid: string) => Promise<JsonWebKey | undefined>;
}> {
    const keyStore = new Map<string, StoredKey>();
    const server = createServer(
        (req, res) => void kmsHandler(req, res, keyStore),
    );
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as AddressInfo;
            resolve({
                server,
                baseUrl: `http://127.0.0.1:${port}`,
                keyIds: () => [...keyStore.keys()],
                publicJwk: async (kid) => {
                    const stored = keyStore.get(kid);
                    return stored && publicJwkOf(stored.pair.publicKey);
                },
            });
        });
    });
}
