/**
 * The container image runs the backend as a non-root user. Files on the host
 * that only root could read (a key of mode 0600, a PKCS#11 library) fail with
 * a permission error that used to work under root. This hint explains that.
 */
const PERMISSION_CODES = new Set(["EACCES", "EPERM"]);

function isPermissionError(error: unknown): boolean {
    if (typeof error !== "object" || error === null) {
        return false;
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code && PERMISSION_CODES.has(code)) {
        return true;
    }
    // dlopen errors (PKCS#11 libraries) carry no code, only the text.
    const message = (error as Error).message;
    return typeof message === "string" && /permission denied/i.test(message);
}

/**
 * Return a sentence to append to the message of an error that occurred while
 * reading `path`, or an empty string when the error is no permission error or
 * the process runs as root.
 */
export function fileAccessHint(
    error: unknown,
    path: string,
    getUid: () => number | undefined = () => process.getuid?.(),
    getGid: () => number | undefined = () => process.getgid?.(),
): string {
    const uid = getUid();
    if (uid === undefined || uid === 0 || !isPermissionError(error)) {
        return "";
    }
    return ` The backend runs as UID ${uid} and GID ${getGid()}, not as root: make ${path} readable by that user, or set EUDIPLO_RUN_AS_ROOT=true to keep the backend running as root (https://docs.eudiplo.dev/operate/docker-compose#non-root-user).`;
}
