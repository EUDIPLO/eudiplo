import { createHash } from "node:crypto";
import {
    BadRequestException,
    Injectable,
    InternalServerErrorException,
    Logger,
    NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { decodeJwt } from "jose";
import { Repository } from "typeorm";
import { AccessCertificateService } from "./access-certificate.service.js";
import { RegistrarConfigEntity } from "./entities/registrar-config.entity.js";
import {
    type RegistrationCertificateCreation,
    registrationCertificateControllerAll,
    registrationCertificateControllerDelete,
    registrationCertificateControllerRegister,
} from "./generated/index.js";
import { RegistrarAuthService } from "./registrar-auth.service.js";

/**
 * Options for resolving a registration certificate.
 */
export interface RegistrationCertificateOptions {
    /**
     * Access key chain whose registrar access certificate is linked to a newly
     * created registration certificate. The tenant's default access key chain
     * when omitted.
     */
    accessKeyChainId?: string;
}

/**
 * Handles registration certificate lifecycle:
 * - Resolving (import / lookup / create) registration certificates
 * - JWT temporal validation and DCQL authorization checks
 * - Stable fingerprint computation used for caching in the VP flow
 */
@Injectable()
export class RegistrationCertificateService {
    private readonly logger = new Logger(RegistrationCertificateService.name);
    private readonly skipOveraskingCheck: boolean;

    constructor(
        @InjectRepository(RegistrarConfigEntity)
        private readonly configRepository: Repository<RegistrarConfigEntity>,
        private readonly authService: RegistrarAuthService,
        configService: ConfigService,
        private readonly accessCertificateService: AccessCertificateService,
    ) {
        this.skipOveraskingCheck =
            configService.get<boolean>("SKIP_OVERASKING_CHECK") ?? false;
    }

    /**
     * Resolve a registration certificate and return only the JWT string.
     */
    async addRegistrationCertificate(
        req: {
            id?: string;
            body?: Partial<RegistrationCertificateCreation>;
            jwt?: string;
        },
        dcqlQuery: any,
        requestId: string,
        tenantId: string,
        options: RegistrationCertificateOptions = {},
    ): Promise<string> {
        const resolved = await this.resolveRegistrationCertificate(
            req,
            dcqlQuery,
            requestId,
            tenantId,
            options,
        );
        return resolved.jwt;
    }

    /**
     * Resolve a registration certificate from a spec (`jwt` import / `id` lookup
     * / `body` creation), validate it against the effective DCQL query and
     * return both the JWT and its decoded payload.
     *
     * This is the canonical entry point used both at presentation-config
     * save-time (eager caching) and at VP-request time (cache miss / refresh).
     */
    async resolveRegistrationCertificate(
        req: {
            id?: string;
            body?: Partial<RegistrationCertificateCreation>;
            jwt?: string;
        },
        dcqlQuery: any,
        requestId: string,
        tenantId: string,
        options: RegistrationCertificateOptions = {},
    ): Promise<{
        jwt: string;
        payload: Record<string, any>;
        source: "imported" | "registrar";
    }> {
        if (req.jwt) {
            const payload = this.validateRegistrationCertificate(
                req.jwt,
                dcqlQuery,
                tenantId,
                requestId,
                "jwt",
            );
            return { jwt: req.jwt, payload, source: "imported" };
        }

        if (!req.id && !req.body) {
            throw new BadRequestException(
                "registrationCert must provide either jwt (import existing), id (reuse existing), or body (create new via registrar)",
            );
        }

        const config = await this.configRepository.findOneBy({ tenantId });
        if (!config) {
            throw new NotFoundException(
                `No registrar configuration found for tenant ${tenantId}`,
            );
        }

        const client = await this.authService.getClient(tenantId);
        const relyingPartyId =
            await this.authService.getRelyingPartyId(tenantId);

        if (req.id) {
            const existingCerts = await registrationCertificateControllerAll({
                client,
                query: { rp: relyingPartyId },
            });

            if (existingCerts.error) {
                this.logger.error(
                    { error: existingCerts.error },
                    `[${tenantId}] Failed to fetch existing registration certificates`,
                );
                throw new BadRequestException(
                    "Failed to query registration certificates",
                );
            }

            const validCerts = existingCerts.data?.filter(
                (cert) => cert.revoked == null && cert.id === req.id,
            );

            if (validCerts && validCerts.length > 0) {
                const payload = this.validateRegistrationCertificate(
                    validCerts[0].jwt,
                    dcqlQuery,
                    tenantId,
                    requestId,
                    "id",
                );
                return { jwt: validCerts[0].jwt, payload, source: "registrar" };
            }

            if (!req.body) {
                throw new BadRequestException(
                    `No active registration certificate found for id '${req.id}'. Provide registrationCert.jwt or registrationCert.body to proceed.`,
                );
            }
        }

        const mergedBody: Partial<RegistrationCertificateCreation> = {
            ...(config.registrationCertificateDefaults ?? {}),
            ...(req.body ?? {}),
        };

        const hasProvidesAttestations =
            Array.isArray(mergedBody.provides_attestations) &&
            mergedBody.provides_attestations.length > 0;

        if (
            !hasProvidesAttestations &&
            !Array.isArray(mergedBody.credentials)
        ) {
            const dcqlCredentials = Array.isArray(dcqlQuery?.credentials)
                ? dcqlQuery.credentials
                : [];
            mergedBody.credentials = dcqlCredentials.map((credential: any) => ({
                format: credential?.format,
                claims: Array.isArray(credential?.claims)
                    ? credential.claims
                    : undefined,
                meta:
                    credential?.meta && typeof credential.meta === "object"
                        ? credential.meta
                        : {},
            })) as any;
        }

        if (!mergedBody.privacy_policy || !mergedBody.support_uri) {
            throw new BadRequestException(
                "registrationCert.body must include privacy_policy and support_uri (directly or via registrar registrationCertificateDefaults)",
            );
        }

        const hasPurpose =
            Array.isArray(mergedBody.purpose) && mergedBody.purpose.length > 0;
        const hasCredentials =
            Array.isArray(mergedBody.credentials) &&
            mergedBody.credentials.length > 0;

        // Two supported certificate intents:
        // 1) Verifier role: must carry purpose and credentials
        // 2) Issuer role: must carry provides_attestations
        if (hasProvidesAttestations) {
            // Issuer role accepted without verifier-specific purpose/credentials constraints.
        } else {
            if (!hasPurpose) {
                throw new BadRequestException(
                    "registrationCert.body must include either provides_attestations (issuer role) or both purpose and credentials (verifier role)",
                );
            }

            if (!hasCredentials) {
                throw new BadRequestException(
                    "registrationCert.body.credentials could not be derived from dcql_query.credentials",
                );
            }
        }

        const accessCertificateId =
            mergedBody.accessCertificateId ||
            (await this.accessCertificateService.findRegistrarAccessCertificateId(
                tenantId,
                client,
                relyingPartyId,
                options.accessKeyChainId,
            ));

        const bodyWithRpId: RegistrationCertificateCreation = {
            ...mergedBody,
            rpId: relyingPartyId,
            accessCertificateId,
        } as RegistrationCertificateCreation;

        const res = await registrationCertificateControllerRegister({
            client,
            body: bodyWithRpId,
        });

        if (res.error) {
            const statusCode = Number(
                (res.error as any)?.statusCode ?? (res.error as any)?.status,
            );
            const upstreamMessage =
                (res.error as any)?.message ||
                (res.error as any)?.error ||
                "Unknown registrar error";

            this.logger.error(
                {
                    error: res.error,
                    statusCode: Number.isFinite(statusCode)
                        ? statusCode
                        : undefined,
                    requestBody: bodyWithRpId,
                },
                `[${tenantId}] Failed to create registration certificate`,
            );

            if (
                Number.isFinite(statusCode) &&
                statusCode >= 400 &&
                statusCode < 500
            ) {
                throw new BadRequestException(
                    `Failed to create registration certificate: ${upstreamMessage}`,
                );
            }

            throw new InternalServerErrorException(
                `Registrar temporarily unavailable while creating registration certificate${Number.isFinite(statusCode) ? ` (upstream status ${statusCode})` : ""}`,
            );
        }

        const newJwt = res.data!.jwt;
        const payload = this.validateRegistrationCertificate(
            newJwt,
            dcqlQuery,
            tenantId,
            requestId,
            "body",
        );
        return { jwt: newJwt, payload, source: "registrar" };
    }

    /**
     * Revoke an active registration certificate identified by its JWT.
     *
     * Returns true when a matching active certificate was found and revoked.
     * Returns false when no active matching certificate exists.
     */
    async revokeRegistrationCertificateByJwt(
        tenantId: string,
        jwt: string,
    ): Promise<boolean> {
        const client = await this.authService.getClient(tenantId);
        const relyingPartyId =
            await this.authService.getRelyingPartyId(tenantId);

        const existingCerts = await registrationCertificateControllerAll({
            client,
            query: { rp: relyingPartyId },
        });

        if (existingCerts.error) {
            this.logger.error(
                { error: existingCerts.error },
                `[${tenantId}] Failed to fetch registration certificates before revoke`,
            );
            throw new BadRequestException(
                "Failed to query registration certificates",
            );
        }

        const matchingActive = existingCerts.data?.find(
            (cert) => cert.revoked == null && cert.jwt === jwt,
        );

        if (!matchingActive?.id) {
            return false;
        }

        const revokeRes = await registrationCertificateControllerDelete({
            client,
            path: { id: matchingActive.id },
        });

        if (revokeRes.error) {
            this.logger.error(
                {
                    error: revokeRes.error,
                    certId: matchingActive.id,
                },
                `[${tenantId}] Failed to revoke registration certificate`,
            );
            throw new BadRequestException(
                "Failed to revoke registration certificate",
            );
        }

        return true;
    }

    // -------------------------------------------------------------------------
    // Fingerprint helpers (public – consumed by PresentationRegistrationCertificateService)
    // -------------------------------------------------------------------------

    /**
     * Compute a canonical fingerprint over a `dcql_query.credentials` array.
     */
    public computeDcqlFingerprint(dcqlQuery: any): string {
        const credentials = Array.isArray(dcqlQuery?.credentials)
            ? dcqlQuery.credentials
            : [];
        const fps = credentials
            .map((c: any) => this.dcqlCredentialFingerprint(c))
            .sort();
        return this.hash(fps.join("|"));
    }

    /**
     * Compute a canonical fingerprint over a registration certificate's
     * authorized `credentials` claim.
     */
    public computeAuthorizedCredentialsFingerprint(
        credentials: unknown,
    ): string {
        const arr = Array.isArray(credentials) ? credentials : [];
        const fps = arr
            .map((c: any) => this.dcqlCredentialFingerprint(c))
            .sort((a, b) => a.localeCompare(b));
        return this.hash(fps.join("|"));
    }

    /**
     * Compute a stable fingerprint over a registration-certificate spec
     * (`{ jwt?, id?, body? }`).
     */
    public computeSpecFingerprint(spec: unknown): string {
        return this.hash(this.canonicalJson(spec ?? null));
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /**
     * Validate a registration certificate JWT against the effective DCQL query.
     *
     * Performs:
     * 1. JWT decoding (structural validation).
     * 2. Temporal validity check (`exp`, `nbf`) with a small clock skew tolerance.
     * 3. DCQL fingerprint comparison: every credential being requested in
     *    `dcqlQuery.credentials` MUST be present in the certificate's authorized
     *    `credentials` claim. Prevents overasking with a cert issued for a
     *    different/narrower set of credentials. Skipped when
     *    `SKIP_OVERASKING_CHECK` is enabled.
     *
     * Fails closed by throwing `BadRequestException` on any mismatch.
     */
    private validateRegistrationCertificate(
        jwt: string,
        dcqlQuery: any,
        tenantId: string,
        requestId: string,
        source: "jwt" | "id" | "body",
    ): Record<string, any> {
        let payload: Record<string, any>;
        try {
            payload = decodeJwt(jwt) as Record<string, any>;
        } catch (err) {
            this.logger.error(
                { err, requestId, source },
                `[${tenantId}] Registration certificate is not a valid JWT`,
            );
            throw new BadRequestException(
                "Registration certificate is not a valid JWT",
            );
        }

        const now = Math.floor(Date.now() / 1000);
        const skew = 60;

        if (typeof payload.exp === "number" && payload.exp + skew < now) {
            this.logger.warn(
                { requestId, source, exp: payload.exp, now },
                `[${tenantId}] Registration certificate is expired`,
            );
            throw new BadRequestException(
                "Registration certificate is expired",
            );
        }

        if (typeof payload.nbf === "number" && payload.nbf - skew > now) {
            this.logger.warn(
                { requestId, source, nbf: payload.nbf, now },
                `[${tenantId}] Registration certificate is not yet valid`,
            );
            throw new BadRequestException(
                "Registration certificate is not yet valid",
            );
        }

        const requestedCredentials = Array.isArray(dcqlQuery?.credentials)
            ? dcqlQuery.credentials
            : [];

        if (requestedCredentials.length === 0) {
            return payload;
        }

        if (this.skipOveraskingCheck) {
            this.logger.warn(
                { requestId, source },
                `[${tenantId}] SKIP_OVERASKING_CHECK is enabled: not checking that the registration certificate authorizes the requested DCQL credentials`,
            );
            return payload;
        }

        const authorizedCredentials = Array.isArray(payload.credentials)
            ? payload.credentials
            : null;

        if (!authorizedCredentials || authorizedCredentials.length === 0) {
            this.logger.warn(
                { requestId, source },
                `[${tenantId}] Registration certificate has no authorized credentials claim`,
            );
            throw new BadRequestException(
                "Registration certificate has no authorized credentials",
            );
        }

        const authorizedFingerprints = new Set(
            authorizedCredentials.map((c: any) =>
                this.dcqlCredentialFingerprint(c),
            ),
        );

        const unauthorized: any[] = [];
        for (const cred of requestedCredentials) {
            const fp = this.dcqlCredentialFingerprint(cred);
            if (!authorizedFingerprints.has(fp)) {
                unauthorized.push(cred);
            }
        }

        if (unauthorized.length > 0) {
            this.logger.error(
                {
                    requestId,
                    source,
                    unauthorizedIds: unauthorized.map((c) => c?.id),
                },
                `[${tenantId}] Registration certificate does not authorize the requested DCQL credentials (overasking prevented)`,
            );
            throw new BadRequestException(
                "Registration certificate does not authorize the requested DCQL credentials",
            );
        }

        return payload;
    }

    /**
     * Compute a stable canonical fingerprint of a single credential entry.
     *
     * Normalizes to registrar CredentialDef shape (`format`, `claims`, `meta`)
     * before hashing, because DCQL credentials may include transport/query fields
     * that are not present in registrar certificates. Claims are reduced to their
     * `path`: certificates only carry the path, while DCQL claims may add `id`,
     * `values` or `intent_to_retain`.
     */
    private dcqlCredentialFingerprint(cred: any): string {
        if (!cred || typeof cred !== "object") {
            return JSON.stringify(cred ?? null);
        }

        const rawClaims = Array.isArray((cred as Record<string, any>).claims)
            ? (cred as Record<string, any>).claims
            : Array.isArray((cred as Record<string, any>).claim)
              ? (cred as Record<string, any>).claim
              : undefined;
        const normalizedClaims = rawClaims?.map((claim: any) => ({
            path: claim?.path,
        }));

        const normalized = {
            format: (cred as Record<string, any>).format,
            claims: normalizedClaims,
            meta:
                (cred as Record<string, any>).meta &&
                typeof (cred as Record<string, any>).meta === "object"
                    ? (cred as Record<string, any>).meta
                    : {},
        };

        return this.canonicalJson(normalized);
    }

    /**
     * Recursively canonicalize a JSON value: object keys sorted, arrays
     * preserved in their original order (DCQL arrays are order-significant).
     */
    private canonicalJson(value: any): string {
        if (value === null || typeof value !== "object") {
            return JSON.stringify(value);
        }
        if (Array.isArray(value)) {
            return `[${value.map((v) => this.canonicalJson(v)).join(",")}]`;
        }
        const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
        return `{${keys
            .map((k) => `${JSON.stringify(k)}:${this.canonicalJson(value[k])}`)
            .join(",")}}`;
    }

    private hash(input: string): string {
        return createHash("sha256").update(input).digest("hex");
    }
}
