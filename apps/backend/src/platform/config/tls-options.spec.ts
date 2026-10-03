import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer, type DetailedPeerCertificate } from "node:tls";
import * as x509 from "@peculiar/x509";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    appendCertificateChain,
    loadTlsOptions,
    TlsConfigurationError,
    type TlsOptions,
} from "./tls-options.js";

const ALGORITHM = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

function generateKeys(): Promise<CryptoKeyPair> {
    return crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"]);
}

async function exportKeyPem(key: CryptoKey): Promise<string> {
    const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", key));
    const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
    return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

const pem = (certificate: x509.X509Certificate) =>
    `${certificate.toString("pem")}\n`;

/** Root CA -> intermediate CA -> leaf for `localhost`. */
async function createChain() {
    x509.cryptoProvider.set(crypto);
    const notBefore = new Date(Date.now() - 60_000);
    const notAfter = new Date(Date.now() + 3_600_000);
    const caExtensions = [
        new x509.BasicConstraintsExtension(true, undefined, true),
        new x509.KeyUsagesExtension(
            x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
            true,
        ),
    ];

    const rootKeys = await generateKeys();
    const root = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "01",
        name: "CN=Test Root CA",
        notBefore,
        notAfter,
        signingAlgorithm: ALGORITHM,
        keys: rootKeys,
        extensions: caExtensions,
    });

    const intermediateKeys = await generateKeys();
    const intermediate = await x509.X509CertificateGenerator.create({
        serialNumber: "02",
        subject: "CN=Test Intermediate CA",
        issuer: root.subject,
        notBefore,
        notAfter,
        signingAlgorithm: ALGORITHM,
        publicKey: intermediateKeys.publicKey,
        signingKey: rootKeys.privateKey,
        extensions: caExtensions,
    });

    const leafKeys = await generateKeys();
    const leaf = await x509.X509CertificateGenerator.create({
        serialNumber: "03",
        subject: "CN=localhost",
        issuer: intermediate.subject,
        notBefore,
        notAfter,
        signingAlgorithm: ALGORITHM,
        publicKey: leafKeys.publicKey,
        signingKey: intermediateKeys.privateKey,
        extensions: [
            new x509.BasicConstraintsExtension(false),
            new x509.SubjectAlternativeNameExtension([
                { type: "dns", value: "localhost" },
            ]),
        ],
    });

    return {
        root: pem(root),
        intermediate: pem(intermediate),
        leaf: pem(leaf),
        leafKey: await exportKeyPem(leafKeys.privateKey),
    };
}

/** Subjects of the certificate chain a client receives from the server. */
async function servedChain(
    options: TlsOptions,
    trustedRoot: string,
): Promise<{ authorized: boolean; subjects: string[] }> {
    const server = createServer(options);
    const connections = new Set<Socket>();
    server.on("connection", (connection: Socket) => {
        connections.add(connection);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
        const { port } = server.address() as AddressInfo;
        return await new Promise((resolve, reject) => {
            // Validation stays on: only the root is trusted, so the handshake
            // fails with a verification error unless the server sends the
            // intermediate.
            const socket = connect(
                {
                    port,
                    ca: trustedRoot,
                    servername: "localhost",
                },
                () => {
                    const subjects: string[] = [];
                    let peer: DetailedPeerCertificate | undefined =
                        socket.getPeerCertificate(true);
                    while (
                        peer &&
                        !subjects.includes(String(peer.subject.CN))
                    ) {
                        subjects.push(String(peer.subject.CN));
                        peer = peer.issuerCertificate;
                    }
                    resolve({ authorized: socket.authorized, subjects });
                    socket.destroy();
                },
            );
            socket.on("error", reject);
        });
    } finally {
        for (const connection of connections) connection.destroy();
        await new Promise((resolve) => server.close(resolve));
    }
}

describe("loadTlsOptions", () => {
    let dir: string;
    let chain: Awaited<ReturnType<typeof createChain>>;
    let paths: Record<
        "leaf" | "key" | "intermediate" | "fullchain" | "notPem",
        string
    >;

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), "eudiplo-tls-"));
        chain = await createChain();
        paths = {
            leaf: join(dir, "cert.pem"),
            key: join(dir, "key.pem"),
            intermediate: join(dir, "ca.pem"),
            fullchain: join(dir, "fullchain.pem"),
            notPem: join(dir, "not-pem.txt"),
        };
        await writeFile(paths.leaf, chain.leaf);
        await writeFile(paths.key, chain.leafKey);
        await writeFile(paths.intermediate, chain.intermediate);
        await writeFile(paths.fullchain, chain.leaf + chain.intermediate);
        await writeFile(paths.notPem, "not a certificate");
    });

    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it.each([undefined, "", "false", "FALSE"])(
        "returns undefined when TLS_ENABLED is %j",
        async (value) => {
            await expect(
                loadTlsOptions({
                    TLS_ENABLED: value,
                    TLS_CERT_PATH: "/does/not/exist",
                }),
            ).resolves.toBeUndefined();
        },
    );

    it.each([
        [{}, "TLS_CERT_PATH and TLS_KEY_PATH are not set"],
        [{ TLS_KEY_PATH: "/key.pem" }, "TLS_CERT_PATH is not set"],
        [{ TLS_CERT_PATH: "/cert.pem", TLS_KEY_PATH: " " }, "TLS_KEY_PATH"],
    ])(
        "fails instead of falling back to HTTP when paths are missing (%j)",
        async (env, message) => {
            const result = loadTlsOptions({ TLS_ENABLED: "true", ...env });
            await expect(result).rejects.toThrow(TlsConfigurationError);
            await expect(result).rejects.toThrow(message);
        },
    );

    it("fails when the certificate file does not exist", async () => {
        await expect(
            loadTlsOptions({
                TLS_ENABLED: "true",
                TLS_CERT_PATH: join(dir, "missing.pem"),
                TLS_KEY_PATH: paths.key,
            }),
        ).rejects.toThrow(/TLS_CERT_PATH .*missing\.pem.* cannot be read/);
    });

    it("fails when the key file does not exist", async () => {
        await expect(
            loadTlsOptions({
                TLS_ENABLED: "true",
                TLS_CERT_PATH: paths.leaf,
                TLS_KEY_PATH: join(dir, "missing-key.pem"),
            }),
        ).rejects.toThrow(/TLS_KEY_PATH .* cannot be read/);
    });

    it("fails when the configured CA file does not exist", async () => {
        await expect(
            loadTlsOptions({
                TLS_ENABLED: "true",
                TLS_CERT_PATH: paths.leaf,
                TLS_KEY_PATH: paths.key,
                TLS_CA_PATH: join(dir, "missing-ca.pem"),
            }),
        ).rejects.toThrow(/TLS_CA_PATH .* cannot be read/);
    });

    it.each(["TLS_CERT_PATH", "TLS_CA_PATH"])(
        "fails when %s contains no PEM certificate",
        async (variable) => {
            await expect(
                loadTlsOptions({
                    TLS_ENABLED: "true",
                    TLS_CERT_PATH: paths.leaf,
                    TLS_KEY_PATH: paths.key,
                    [variable]: paths.notPem,
                }),
            ).rejects.toThrow(`${variable} (${paths.notPem}) does not contain`);
        },
    );

    it("loads certificate, key and passphrase", async () => {
        const options = await loadTlsOptions({
            TLS_ENABLED: "True",
            TLS_CERT_PATH: paths.leaf,
            TLS_KEY_PATH: paths.key,
            TLS_KEY_PASSPHRASE: "secret",
        });

        expect(options?.cert.toString()).toBe(chain.leaf);
        expect(options?.key.toString()).toBe(chain.leafKey);
        expect(options?.passphrase).toBe("secret");
        expect(options).not.toHaveProperty("ca");
    });

    // The first TLS context of a process initializes OpenSSL, which takes
    // several seconds on some machines.
    it("serves the TLS_CA_PATH certificates as intermediate chain", {
        timeout: 30_000,
    }, async () => {
        const options = await loadTlsOptions({
            TLS_ENABLED: "true",
            TLS_CERT_PATH: paths.leaf,
            TLS_KEY_PATH: paths.key,
            TLS_CA_PATH: paths.intermediate,
        });

        expect(options?.cert.toString()).toBe(chain.leaf + chain.intermediate);
        await expect(servedChain(options!, chain.root)).resolves.toEqual({
            authorized: true,
            subjects: ["localhost", "Test Intermediate CA", "Test Root CA"],
        });
    });

    it("does not duplicate intermediates already in TLS_CERT_PATH", async () => {
        const options = await loadTlsOptions({
            TLS_ENABLED: "true",
            TLS_CERT_PATH: paths.fullchain,
            TLS_KEY_PATH: paths.key,
            TLS_CA_PATH: paths.intermediate,
        });

        expect(options?.cert.toString()).toBe(chain.leaf + chain.intermediate);
    });
});

describe("appendCertificateChain", () => {
    const block = (body: string) =>
        `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;

    it("separates the chain with a newline when the cert lacks one", () => {
        const result = appendCertificateChain(
            Buffer.from(block("LEAF")),
            Buffer.from(`${block("INT")}\n${block("ROOT")}\n`),
        );

        expect(result.toString()).toBe(
            `${block("LEAF")}\n${block("INT")}\n${block("ROOT")}\n`,
        );
    });

    it("returns the cert unchanged when nothing is missing", () => {
        const cert = Buffer.from(`${block("LEAF")}\n${block("INT")}\n`);

        expect(appendCertificateChain(cert, Buffer.from(block("INT")))).toBe(
            cert,
        );
    });
});
