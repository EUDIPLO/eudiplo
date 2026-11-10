import { Injectable } from "@nestjs/common";

/**
 * Runs the generation of a tenant's issuer registration certificate one at a
 * time within this process: a metadata request, a background renewal and
 * **Regenerate now** read the cached certificate, request a new one and revoke
 * the replaced one, so two of them running at once would leave a certificate
 * active at the registrar that EUDIPLO no longer tracks.
 */
@Injectable()
export class IssuerRegistrationCertificateLock {
    private readonly tails = new Map<string, Promise<unknown>>();

    run<T>(tenantId: string, task: () => Promise<T>): Promise<T> {
        const previous = this.tails.get(tenantId) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(task);
        this.tails.set(tenantId, next);
        const release = () => {
            if (this.tails.get(tenantId) === next) {
                this.tails.delete(tenantId);
            }
        };
        next.then(release, release);
        return next;
    }
}
