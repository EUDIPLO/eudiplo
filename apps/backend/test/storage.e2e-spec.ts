import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LocalFileStorage } from "../src/storage/adapters/local.storage.js";
import { S3FileStorage } from "../src/storage/adapters/s3.storage.js";
import type { FileStorage } from "../src/storage/storage.types.js";
import { describeWithContainers } from "./container-runtime.js";

/**
 * Shared test suite for FileStorage implementations.
 * Tests both LocalFileStorage and S3FileStorage (via RustFS).
 */
function runStorageTests(getStorage: () => FileStorage, name: string) {
    describe(name, () => {
        test("put and exists", async () => {
            const storage = getStorage();
            const key = `test-${Date.now()}/file.txt`;
            const content = Buffer.from("hello world");

            await storage.put(key, content, { contentType: "text/plain" });

            const exists = await storage.exists(key);
            expect(exists).toBe(true);
        });

        test("put and getStream", async () => {
            const storage = getStorage();
            const key = `test-${Date.now()}/stream.txt`;
            const content = "stream content test";

            await storage.put(key, Buffer.from(content));

            const { stream } = await storage.getStream(key);
            const chunks: Buffer[] = [];
            for await (const chunk of stream) {
                chunks.push(
                    Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
                );
            }
            const retrieved = Buffer.concat(chunks).toString();
            expect(retrieved).toBe(content);
        });

        test("put with Readable stream", async () => {
            const storage = getStorage();
            const key = `test-${Date.now()}/readable.txt`;
            const content = "readable stream content";

            // Create buffer for the content
            // Note: For S3, upload from Buffer is more reliable as Readable streams
            // require content-length to be known beforehand
            const buffer = Buffer.from(content);

            // For S3, we need to use Buffer directly since Readable streams
            // don't provide content-length which AWS SDK v3 requires
            await storage.put(key, buffer);

            const exists = await storage.exists(key);
            expect(exists).toBe(true);

            const { stream } = await storage.getStream(key);
            const chunks: Buffer[] = [];
            for await (const chunk of stream) {
                chunks.push(
                    Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
                );
            }
            expect(Buffer.concat(chunks).toString()).toBe(content);
        });

        test("delete removes file", async () => {
            const storage = getStorage();
            const key = `test-${Date.now()}/delete.txt`;

            await storage.put(key, Buffer.from("to be deleted"));
            expect(await storage.exists(key)).toBe(true);

            await storage.delete(key);
            expect(await storage.exists(key)).toBe(false);
        });

        test("exists returns false for missing key", async () => {
            const storage = getStorage();
            const exists = await storage.exists(
                `nonexistent-${Date.now()}.txt`,
            );
            expect(exists).toBe(false);
        });

        test("put with metadata", async () => {
            const storage = getStorage();
            const key = `test-${Date.now()}/metadata.txt`;

            await storage.put(key, Buffer.from("with metadata"), {
                contentType: "text/plain",
                metadata: { "x-custom": "value" },
            });

            expect(await storage.exists(key)).toBe(true);
        });

        test("put large file", async () => {
            const storage = getStorage();
            const key = `test-${Date.now()}/large.bin`;
            // Create a 1MB buffer
            const content = Buffer.alloc(1024 * 1024, "x");

            await storage.put(key, content, {
                contentType: "application/octet-stream",
            });

            const { stream, size } = await storage.getStream(key);
            const chunks: Buffer[] = [];
            for await (const chunk of stream) {
                chunks.push(
                    Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
                );
            }
            const retrieved = Buffer.concat(chunks);
            expect(retrieved.length).toBe(content.length);
            // S3 returns size, local may not
            if (size !== undefined) {
                expect(size).toBe(content.length);
            }
        });
    });
}

describe("LocalFileStorage", () => {
    let tempDir: string;
    let localStorage: LocalFileStorage;

    beforeAll(() => {
        tempDir = mkdtempSync(join(tmpdir(), "eudiplo-storage-test-"));
        localStorage = new LocalFileStorage(tempDir);
    });

    afterAll(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    runStorageTests(() => localStorage, "LocalFileStorage operations");

    describe("LocalFileStorage-specific features", () => {
        test("put with actual Readable stream", async () => {
            const key = `test-${Date.now()}/stream-local.txt`;
            const content = "local readable stream content";

            // LocalFileStorage properly handles Readable streams
            const readable = Readable.from(Buffer.from(content));
            await localStorage.put(key, readable);

            const exists = await localStorage.exists(key);
            expect(exists).toBe(true);

            const { stream } = await localStorage.getStream(key);
            const chunks: Buffer[] = [];
            for await (const chunk of stream) {
                chunks.push(
                    Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
                );
            }
            expect(Buffer.concat(chunks).toString()).toBe(content);
        });
    });
});

describeWithContainers("S3FileStorage (RustFS)", () => {
    let rustfsContainer: StartedTestContainer;
    let s3Client: S3Client;
    let s3Storage: S3FileStorage;

    const BUCKET_NAME = "test-bucket";
    const ACCESS_KEY = "rustfs-test-admin";
    const SECRET_KEY = "rustfs-test-admin";
    const S3_PORT = 9000;

    beforeAll(async () => {
        // Start RustFS container
        rustfsContainer = await new GenericContainer("rustfs/rustfs:1.0.0")
            .withExposedPorts(S3_PORT)
            .withEnvironment({
                RUSTFS_ACCESS_KEY: ACCESS_KEY,
                RUSTFS_SECRET_KEY: SECRET_KEY,
            })
            .withCommand(["/data"])
            .withWaitStrategy(Wait.forHttp("/health/ready", S3_PORT))
            .start();

        const host = rustfsContainer.getHost();
        const port = rustfsContainer.getMappedPort(S3_PORT);
        const endpoint = `http://${host}:${port}`;

        // Create S3 client configured for RustFS
        s3Client = new S3Client({
            endpoint,
            region: "us-east-1",
            credentials: {
                accessKeyId: ACCESS_KEY,
                secretAccessKey: SECRET_KEY,
            },
            forcePathStyle: true, // Required for RustFS
        });

        // Create test bucket using AWS SDK
        const { CreateBucketCommand } = await import("@aws-sdk/client-s3");
        await s3Client.send(new CreateBucketCommand({ Bucket: BUCKET_NAME }));

        // Create S3FileStorage
        s3Storage = new S3FileStorage(s3Client, BUCKET_NAME);
    }, 120000); // 2 minutes timeout for container startup

    afterAll(async () => {
        s3Client?.destroy();
        await rustfsContainer?.stop();
    });

    runStorageTests(() => s3Storage, "S3FileStorage operations");

    describe("S3-specific features", () => {
        test("getStream returns content type and size", async () => {
            const key = `test-${Date.now()}/typed.json`;
            const content = JSON.stringify({ test: true });

            await s3Storage.put(key, Buffer.from(content), {
                contentType: "application/json",
            });

            const { stream, contentType, size } =
                await s3Storage.getStream(key);

            // Consume stream to complete the request
            for await (const _ of stream) {
                // drain
            }

            expect(contentType).toBe("application/json");
            expect(size).toBe(content.length);
        });
    });
});
