import {
    createReadStream,
    createWriteStream,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { pipeline, Readable } from "node:stream";
import {
    FileStorage,
    InvalidStorageKeyError,
    type PutOptions,
    StoredObjectNotFoundError,
} from "../storage.types.js";

/** fs errors that mean nothing is stored under the path. */
const MISSING_FILE_CODES = new Set(["ENOENT", "ENOTDIR", "ENAMETOOLONG"]);

/**
 * Local file storage implementation for development and testing.
 */
export class LocalFileStorage implements FileStorage {
    /**
     * Creates a new instance of LocalFileStorage.
     * @param baseDir
     */
    constructor(private readonly baseDir: string) {}

    private resolveSafePath(key: string): string {
        if (!key || key.includes("\0")) {
            throw new InvalidStorageKeyError();
        }

        const basePath = resolve(this.baseDir);
        const fullPath = resolve(basePath, key);
        const relativePath = relative(basePath, fullPath);

        // Reject absolute paths and any path escaping the base directory.
        if (
            relativePath.startsWith("..") ||
            relativePath.includes(`/..`) ||
            relativePath === ""
        ) {
            throw new InvalidStorageKeyError();
        }

        return fullPath;
    }

    /**
     * Saves a file to the local storage.
     * @param key
     * @param body
     */
    async put(
        key: string,
        body: Buffer | Readable,
        opts?: PutOptions,
    ): Promise<void> {
        const fullPath = this.resolveSafePath(key);
        mkdirSync(dirname(fullPath), { recursive: true });

        await new Promise<void>((resolve, reject) => {
            const write = createWriteStream(fullPath);
            const src = body instanceof Readable ? body : Readable.from(body);
            pipeline(src, write, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        if (opts?.contentType) {
            writeFileSync(
                `${fullPath}.meta`,
                JSON.stringify({ contentType: opts.contentType }),
            );
        }
    }

    /**
     * Retrieves a file stream from the local storage.
     * @param key
     * @returns
     */
    // async, so that every failure is a rejection, as the FileStorage port promises
    async getStream(key: string) {
        const fullPath = this.resolveSafePath(key);
        let stat: ReturnType<typeof statSync>;
        try {
            stat = statSync(fullPath);
        } catch (error: any) {
            if (MISSING_FILE_CODES.has(error?.code)) {
                throw new StoredObjectNotFoundError(key);
            }
            throw error;
        }
        if (!stat.isFile()) {
            throw new StoredObjectNotFoundError(key);
        }
        const metaPath = `${fullPath}.meta`;
        const contentType = existsSync(metaPath)
            ? JSON.parse(readFileSync(metaPath, "utf-8")).contentType
            : undefined;
        return {
            stream: createReadStream(fullPath),
            contentType,
            size: stat.size,
        };
    }

    /**
     * Deletes a file from the local storage.
     * @param key
     * @returns
     */
    delete(key: string) {
        const fullPath = this.resolveSafePath(key);
        rmSync(fullPath);
        const metaPath = `${fullPath}.meta`;
        if (existsSync(metaPath)) rmSync(metaPath);
        return Promise.resolve();
    }

    /**
     * Checks if a file exists in the local storage.
     * @param key
     * @returns
     */
    exists(key: string) {
        try {
            return Promise.resolve(existsSync(this.resolveSafePath(key)));
        } catch {
            return Promise.resolve(false);
        }
    }
}
