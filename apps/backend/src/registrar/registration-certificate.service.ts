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
import { Repository } from "typeorm";
import { AccessCertificateService } from "./access-certificate.service.js";
import {
    canonicalJson,
    checkRegistrationCertificate,
    credentialFingerprint,
} from "./domain/registration-certificate-check.js";
import { RegistrarConfigEntity } from "./entities/registrar-config.entity.js";
import {
    type RegistrationCertificateCreation,
    registrationCertificateControllerAll,
    registrationCertificateControllerDelete,
    registrationCertificateControllerRegister,
} from "./generated/index.js";
import { RegistrarAuthService } from "./registrar-auth.service.js";
import { registrarErrorMessage } from "./registrar-error-message.js";

/**
 * Options for resolving a registration certificate.
 */
export interface RegistrationCertificateOptions {
    /**
     * Access key chain whose registrar access certificate, if any, is linked to
     * a newly created registration certificate. The tenant's default access
     * key chain when omitted.
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

        // custom_provides_attestations selects the issuer role only from the
        // request itself (a generated issuer certificate), never from the
        // registrar defaults. provides_attestations still counts from either.
        const hasProvidesAttestations =
            (Array.isArray(mergedBody.provides_attestations) &&
                mergedBody.provides_attestations.length > 0) ||
            (Array.isArray(req.body?.custom_provides_attestations) &&
                req.body.custom_provides_attestations.length > 0);

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
        // 2) Issuer role: must carry provides_attestations or
        //    custom_provides_attestations
        if (hasProvidesAttestations) {
            // Issuer role accepted without verifier-specific purpose/credentials constraints.
        } else {
            if (!hasPurpose) {
                throw new BadRequestException(
                    "registrationCert.body must include either provides_attestations or custom_provides_attestations (issuer role) or both purpose and credentials (verifier role)",
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
            ...(accessCertificateId ? { accessCertificateId } : {}),
        } as RegistrationCertificateCreation;

        const res = await registrationCertificateControllerRegister({
            client,
            body: bodyWithRpId,
        });

        if (res.error) {
            const statusCode = Number(
                (res.error as any)?.statusCode ?? (res.error as any)?.status,
            );
            const upstreamMessage = registrarErrorMessage(res.error);

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
            .map((c: any) => credentialFingerprint(c))
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
            .map((c: any) => credentialFingerprint(c))
            .sort((a, b) => a.localeCompare(b));
        return this.hash(fps.join("|"));
    }

    /**
     * Compute a stable fingerprint over a registration-certificate spec
     * (`{ jwt?, id?, body? }`).
     */
    public computeSpecFingerprint(spec: unknown): string {
        return this.hash(canonicalJson(spec ?? null));
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /**
     * Validate a registration certificate JWT against the effective DCQL query
     * (see {@link checkRegistrationCertificate}): decoding, `exp`/`nbf` and,
     * unless `SKIP_OVERASKING_CHECK` is enabled, that the certificate authorizes
     * every requested credential.
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
        const result = checkRegistrationCertificate(jwt, dcqlQuery, {
            skipOveraskingCheck: this.skipOveraskingCheck,
        });
        if (result.problem) {
            const { code, message, unauthorizedCredentialIds } = result.problem;
            const level =
                code === "INVALID_JWT" || code === "OVERASKING"
                    ? "error"
                    : "warn";
            this.logger[level](
                {
                    requestId,
                    source,
                    ...(unauthorizedCredentialIds
                        ? { unauthorizedIds: unauthorizedCredentialIds }
                        : {}),
                },
                `[${tenantId}] ${message}${code === "OVERASKING" ? " (overasking prevented)" : ""}`,
            );
            throw new BadRequestException(message);
        }

        if (
            this.skipOveraskingCheck &&
            Array.isArray(dcqlQuery?.credentials) &&
            dcqlQuery.credentials.length > 0
        ) {
            this.logger.warn(
                { requestId, source },
                `[${tenantId}] SKIP_OVERASKING_CHECK is enabled: not checking that the registration certificate authorizes the requested DCQL credentials`,
            );
        }
        return result.payload;
    }

    private hash(input: string): string {
        return createHash("sha256").update(input).digest("hex");
    }
}
