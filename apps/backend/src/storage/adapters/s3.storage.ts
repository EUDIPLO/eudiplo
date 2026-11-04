// src/storage/adapters/s3.storage.ts

import { Readable } from "node:stream";
import {
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    NoSuchKey,
    NotFound,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";
import {
    FileStorage,
    PutOptions,
    StoredObjectNotFoundError,
} from "../storage.types.js";

/**
 * Whether an S3 error means nothing is stored under the key. The name check
 * covers SDK versions whose errors are not instances of these classes.
 */
export function isMissingObject(error: unknown): boolean {
    return (
        error instanceof NotFound ||
        error instanceof NoSuchKey ||
        (error instanceof Error &&
            (error.name === "NotFound" || error.name === "NoSuchKey"))
    );
}

/**
 * S3 file storage implementation using AWS SDK v3.
 */
export class S3FileStorage implements FileStorage {
    /**
     * Creates a new instance of S3FileStorage.
     * @param s3
     * @param bucket
     */
    constructor(
        private readonly s3: S3Client,
        private readonly bucket: string,
    ) {}

    /**
     * Saves a file to S3 storage.
     * @param key
     * @param body
     * @param opts
     */
    async put(
        key: string,
        body: Buffer | Readable,
        opts?: PutOptions,
    ): Promise<void> {
        await this.s3.send(
            new PutObjectCommand({
                Bucket: this.bucket,
                Key: key,
                Body: body,
                ContentType: opts?.contentType,
                Metadata: opts?.metadata,
                ACL: opts?.acl === "public" ? "public-read" : undefined,
                ChecksumSHA256: opts?.checksum,
            }),
        );
    }

    /**
     * Retrieves a file stream from S3 storage.
     * @param key
     * @returns
     */
    async getStream(key: string) {
        const obj = await this.s3
            .send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
            .catch((error: unknown) => {
                throw isMissingObject(error)
                    ? new StoredObjectNotFoundError(key)
                    : error;
            });
        return {
            stream: obj.Body as Readable,
            contentType: obj.ContentType,
            size: obj.ContentLength,
        };
    }

    /**
     * Deletes a file from S3 storage.
     * @param key
     */
    async delete(key: string) {
        await this.s3.send(
            new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
        );
    }

    /**
     * Checks if a file exists in S3 storage.
     * @param key
     * @returns
     */
    async exists(key: string): Promise<boolean> {
        try {
            await this.s3.send(
                new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
            );
            return true;
        } catch (error) {
            // Only treat NotFound/NoSuchKey as "not exists", rethrow other errors
            if (isMissingObject(error)) {
                return false;
            }
            throw error;
        }
    }
}
