// src/storage/storage.types.ts
import { Readable } from "node:stream";

export type PutOptions = {
    contentType?: string;
    metadata?: Record<string, string>;
    acl?: "private" | "public";
    checksum?: string; // e.g., sha256 base64
};

export type StoredObject = {
    key: string; // canonical key (e.g. "tenant/2025/08/14/uuid.ext")
    etag?: string;
    size?: number;
    url?: string; // public URL if ACL=public or a presigned URL
    contentType?: string;
    metadata?: Record<string, string>;
};

export interface FileStorage {
    put(key: string, body: Buffer | Readable, opts?: PutOptions): Promise<void>;

    /**
     * @throws StoredObjectNotFoundError when no object is stored under the key.
     */
    getStream(
        key: string,
    ): Promise<{ stream: Readable; contentType?: string; size?: number }>;

    delete(key: string): Promise<void>;

    exists(key: string): Promise<boolean>;
}

export const FILE_STORAGE = Symbol("FILE_STORAGE");

/**
 * Thrown by a storage adapter for a key that cannot name a stored object,
 * for example one that escapes the storage folder.
 */
export class InvalidStorageKeyError extends Error {
    constructor() {
        super("Invalid storage key");
        this.name = "InvalidStorageKeyError";
    }
}

/**
 * Thrown by a storage adapter when no object is stored under a key.
 */
export class StoredObjectNotFoundError extends Error {
    constructor(key: string) {
        super(`No stored object for key ${JSON.stringify(key)}`);
        this.name = "StoredObjectNotFoundError";
    }
}
