/**
 * ISO 18013-7 Annex C — org.iso.mdoc DC API flow.
 *
 * Handles offer creation (DeviceRequest + encryptionInfo) and
 * encrypted device response processing (HPKE decrypt → verify → webhook).
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
    BadRequestException,
    Inject,
    Injectable,
    NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import type { ItemsRequest, ReaderAuth } from "@owf/mdoc";
import { X509Certificate } from "@peculiar/x509";
import { exportJWK } from "jose";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Repository } from "typeorm";
import { EncryptionService } from "../../crypto/encryption/encryption.service.js";
import { CertService } from "../../crypto/key/cert/cert.service.js";
import { KeyChainService } from "../../crypto/key/key-chain.service.js";
import { KeyUsageType } from "../../crypto/key/types/key-usage-type.js";
import { WebhookEndpointEntity } from "../../issuer/configuration/webhook-endpoint/entities/webhook-endpoint.entity.js";
import { ChangeSessionState } from "../../session/application/change-session-state.js";
import { CreateSession } from "../../session/application/create-session.js";
import { SessionStore } from "../../session/application/session-store.js";
import type {
    SessionData,
    SessionUpdate,
} from "../../session/domain/session-data.js";
import type { SessionOutcome } from "../../session/domain/session-outcome.js";
import { SessionStatus } from "../../session/domain/session-state.js";
import {
    assertSessionUsable,
    SessionNotUsable,
} from "../../session/domain/session-usability.js";
import { SessionAuditService } from "../../session/logging/session-audit.service.js";
import {
    DEFAULT_VERIFIER_SKEW_SECONDS,
    RevocationCheckMode,
    VerifierOptions,
} from "../../trust/types.js";
import {
    PRESENTATION_RESULT_PUBLISHER,
    type PresentationResult,
    type PresentationResultPublisher,
    type PresentationResultReport,
} from "../../webhook/ports/presentation-result-publisher.js";
import { WebhookConfig } from "../../webhook/webhook.dto.js";
import { CredentialVerifierFormatRegistry } from "../presentations/application/credential-verifier-format-registry.js";
import { PresentationConfigService } from "../presentations/configuration/presentation-config.service.js";
import { verificationFailureDetails } from "../presentations/credential/verification-failure.js";
import {
    trustListAuthorities,
    verifierTrustOptions,
} from "../presentations/domain/verifier-trust-options.js";
import { InvalidTrustedAuthoritiesError } from "../presentations/ports/trust-list-ref-resolver.js";
import { TrustedAuthoritiesService } from "../presentations/trusted-authorities.service.js";
import {
    buildDeviceRequestCbor,
    buildEncryptionInfo,
    buildIsoMdocDcApiTranscript,
    buildItemsRequest,
    buildReaderAuth,
    parseEncryptedResponse,
} from "./cbor-request.js";
import { hpkeOpen } from "./hpke.js";

export interface Iso18013Offer {
    session: string;
    uri: string;
    crossDeviceUri: string;
    org_iso_mdoc: {
        device_request: string; // base64url CBOR DeviceRequest
        encryption_info: string; // base64url CBOR EncryptionInfo
    };
}

@Injectable()
export class Iso18013Service {
    constructor(
        private readonly presentationConfigService: PresentationConfigService,
        private readonly createSession: CreateSession,
        private readonly sessionStore: SessionStore,
        private readonly encryptionService: EncryptionService,
        private readonly credentialVerifierFormats: CredentialVerifierFormatRegistry,
        @Inject(PRESENTATION_RESULT_PUBLISHER)
        private readonly presentationResultPublisher: PresentationResultPublisher,
        private readonly auditLogService: SessionAuditService,
        private readonly configService: ConfigService,
        private readonly certService: CertService,
        private readonly keyChainService: KeyChainService,
        @InjectRepository(WebhookEndpointEntity)
        private readonly webhookEndpointRepo: Repository<WebhookEndpointEntity>,
        @InjectPinoLogger(Iso18013Service.name)
        private readonly logger: PinoLogger,
        private readonly trustedAuthoritiesService: TrustedAuthoritiesService,
        private readonly changeSessionState: ChangeSessionState,
    ) {}

    /**
     * Persists a failed outcome, announces the terminal transition and
     * reports the failure to the presentation webhook.
     */
    private async failSession(
        session: SessionData,
        update: Omit<SessionUpdate, "status" | "outcome"> & {
            outcome: SessionOutcome;
        },
    ): Promise<void> {
        // Conditional, so a completed or expired session keeps its state.
        const updated = await this.sessionStore.updateIfUnconsumed(
            session.tenantId,
            session.id,
            { ...update, status: SessionStatus.Failed },
        );
        if (!updated) {
            return;
        }
        this.changeSessionState.announce(session, SessionStatus.Failed);

        // Failures are answered without a redirect, so a redirectUri the
        // webhook returns is not used here.
        const webhook = await this.resolveSessionWebhook(session).catch(
            (err: any) => {
                this.logger.warn(
                    { sessionId: session.id },
                    `Webhook lookup failed: ${err?.message ?? err}`,
                );
                return undefined;
            },
        );
        if (webhook) {
            await this.publishResult(webhook, session, {
                status: SessionStatus.Failed,
                outcome: update.outcome,
            });
        }
    }

    /** The request's inline webhook, else the configured webhook endpoint. */
    private async resolveSessionWebhook(
        session: SessionData,
    ): Promise<WebhookConfig | undefined> {
        return (
            session.parsedWebhook ??
            (await this.resolveWebhookFromEndpoint(
                session.webhookEndpointId,
                session.tenantId,
            ))
        );
    }

    /**
     * Sends the presentation result to the webhook. Best effort: a failed
     * delivery never changes the session result.
     */
    private publishResult(
        webhook: WebhookConfig,
        session: SessionData,
        result: PresentationResultReport,
    ): Promise<PresentationResult | undefined> {
        return this.presentationResultPublisher
            .publish({ webhook, session, ...result })
            .catch((err: any) => {
                this.logger.warn(
                    { sessionId: session.id },
                    `Webhook delivery failed: ${err?.message ?? err}`,
                );
                return undefined;
            });
    }

    private async resolveWebhookFromEndpoint(
        webhookEndpointId: string | null | undefined,
        tenantId: string,
    ): Promise<WebhookConfig | undefined> {
        if (!webhookEndpointId) {
            return undefined;
        }

        const endpoint = await this.webhookEndpointRepo.findOneBy({
            id: webhookEndpointId,
            tenantId,
        });
        if (!endpoint) {
            this.logger.warn(
                {
                    tenantId,
                    webhookEndpointId,
                },
                "Webhook endpoint configured on presentation config was not found",
            );
            return undefined;
        }

        return { url: endpoint.url, auth: endpoint.auth };
    }

    /**
     * Create an ISO 18013-7 Annex C offer: build DeviceRequest + encryptionInfo
     * and persist a session for the response phase.
     */
    async createOffer(
        requestId: string,
        tenantId: string,
        origin: string,
        skewSeconds?: number,
        webhook?: WebhookConfig,
    ): Promise<Iso18013Offer> {
        const config =
            await this.presentationConfigService.getPresentationConfig(
                requestId,
                tenantId,
            );

        const pubJwk =
            await this.encryptionService.getEncryptionPublicKey(tenantId);
        const nonce = randomBytes(16);
        const sessionId = randomUUID();

        // Find the first mso_mdoc credential in the DCQL query
        const mdocCred = config.dcql_query.credentials.find(
            (c) => c.format === "mso_mdoc",
        );
        if (!mdocCred) {
            throw new BadRequestException(
                `Presentation config "${requestId}" has no mso_mdoc credential`,
            );
        }

        // `doctype_value` is the field the OpenID4VP DCQL spec defines for
        // mso_mdoc `meta`, and the only one CredentialQueryMsoMdocSchema
        // accepts: it is .strict() and marks doctype_value required.
        //
        // Reading the non-spec `doctype` here left no valid configuration: one
        // carrying it is rejected on write by the strict schema, and one
        // without it fails every ISO 18013-7 offer. The rest of the codebase
        // already treats doctype_value as authoritative — see
        // schema-metadata-submission.service.ts, which only ever writes it.
        const docType = (mdocCred.meta as { doctype_value?: string })
            ?.doctype_value;
        if (!docType) {
            throw new BadRequestException(
                `Presentation config "${requestId}" mso_mdoc credential has no meta.doctype_value`,
            );
        }

        // Build namespace→claims map from DCQL claims
        const namespaces: Record<string, Record<string, boolean>> = {};
        for (const claim of mdocCred.claims ?? []) {
            if (claim.path.length === 0) continue;
            const ns = claim.path.length > 1 ? claim.path[0] : docType;
            const claimName =
                claim.path.length > 1 ? claim.path[1] : claim.path[0];
            if (!namespaces[ns]) namespaces[ns] = {};
            namespaces[ns][claimName] = false; // intentToRetain = false
        }
        if (Object.keys(namespaces).length === 0) {
            namespaces[docType] = {};
        }

        const encryptionInfoCbor = buildEncryptionInfo(
            pubJwk.x!,
            pubJwk.y!,
            nonce,
        );

        // A single ItemsRequest instance is shared between the DocRequest and,
        // when reader authentication is enabled, the ReaderAuthentication that is
        // signed over it — the wallet recomputes the latter from the former.
        const itemsRequest = buildItemsRequest(docType, namespaces);

        const readerAuth = config.readerAuth
            ? await this.buildReaderAuthForOffer(
                  tenantId,
                  config.accessKeyChainId ?? undefined,
                  itemsRequest,
                  encryptionInfoCbor.toString("base64url"),
                  origin,
              )
            : undefined;

        const deviceRequestCbor = buildDeviceRequestCbor(
            itemsRequest,
            readerAuth,
        );

        const expiresAt = new Date(
            Date.now() + (config.lifeTime ?? 300) * 1000,
        );
        const endpointWebhook = await this.resolveWebhookFromEndpoint(
            config.webhookEndpointId,
            tenantId,
        );
        const resolvedWebhook = webhook ?? endpointWebhook;

        await this.createSession.execute({
            id: sessionId,
            tenantId,
            requestId,
            useDcApi: true,
            dcApiProtocol: "iso-18013-7",
            browserOrigin: origin,
            vp_nonce: nonce.toString("hex"),
            webhookEndpointId: config.webhookEndpointId ?? undefined,
            parsedWebhook: resolvedWebhook,
            redirectUri: config.redirectUri ?? undefined,
            skewSeconds:
                skewSeconds ??
                config.skewSeconds ??
                DEFAULT_VERIFIER_SKEW_SECONDS,
            expiresAt,
            status: SessionStatus.Active,
        });

        return {
            session: sessionId,
            uri: "",
            crossDeviceUri: "",
            org_iso_mdoc: {
                device_request: deviceRequestCbor.toString("base64url"),
                encryption_info: encryptionInfoCbor.toString("base64url"),
            },
        };
    }

    /**
     * Build a detached ReaderAuth (COSE_Sign1) for the offer, signing the
     * ReaderAuthentication structure with the tenant's Access key chain.
     *
     * The DCAPIHandover SessionTranscript is reconstructed deterministically from
     * the EncryptionInfo (base64url) and browser origin — identical to the one
     * the wallet derives — so the reader signature binds to this exact request.
     *
     * Note: signing extracts the Access private key as a JWK (mirroring mDOC
     * issuance), so KMS-backed non-extractable keys are not yet supported for
     * reader authentication.
     */
    private async buildReaderAuthForOffer(
        tenantId: string,
        accessKeyChainId: string | undefined,
        itemsRequest: ItemsRequest,
        encryptionInfoB64u: string,
        origin: string,
    ): Promise<ReaderAuth> {
        const { sessionTranscript } = await buildIsoMdocDcApiTranscript(
            encryptionInfoB64u,
            origin,
        );

        const cert = await this.certService.find({
            tenantId,
            type: KeyUsageType.Access,
            keyId: accessKeyChainId,
        });

        const keyChain = await this.keyChainService.getEntity(
            tenantId,
            cert.keyId,
        );
        const signingJwk = (await exportJWK(
            await crypto.subtle.importKey(
                "jwk",
                keyChain.activeJwk,
                { name: "ECDSA", namedCurve: "P-256" },
                true,
                ["sign"],
            ),
        )) as Record<string, unknown>;

        const certificateChain = cert.crt.map(
            (pem) => new Uint8Array(new X509Certificate(pem).rawData),
        );

        return buildReaderAuth(
            itemsRequest,
            sessionTranscript,
            signingJwk,
            certificateChain,
        );
    }

    /**
     * Process the HPKE-encrypted DeviceResponse returned by the wallet via DC API.
     *
     * @param sessionId     Session UUID returned by createOffer
     * @param encryptedB64  base64url-encoded HPKE output: enc(65B) || ciphertext
     */
    async processResponse(
        sessionId: string,
        encryptedB64: string,
    ): Promise<Record<string, unknown>> {
        let session;
        try {
            session = await this.sessionStore.getIso18013(sessionId);
        } catch {
            throw new NotFoundException("ISO 18013-7 session not found");
        }

        if (session.consumed) {
            throw new BadRequestException(
                "The presentation offer has already been used",
            );
        }
        try {
            assertSessionUsable(session, new Date());
        } catch (error) {
            if (error instanceof SessionNotUsable) {
                throw new BadRequestException(error.message);
            }
            throw error;
        }

        const logContext = {
            sessionId: session.id,
            tenantId: session.tenantId,
            flowType: "ISO18013" as const,
            stage: "response_processing",
        };

        this.auditLogService.logFlowStart(logContext, {
            action: "process_iso18013_response",
        });

        const privJwk = await this.encryptionService.getEncryptionPrivateJwk(
            session.tenantId,
        );

        const nonce = Buffer.from(session.vp_nonce!, "hex");
        const origin = session.browserOrigin!;

        // Reconstruct the DCAPIHandover SessionTranscript from stored session data.
        // The handover hashes the base64url EncryptionInfo exactly as sent in the
        // offer; buildEncryptionInfo is deterministic, so re-encoding the stored
        // nonce with the tenant key reproduces the identical string.
        const encryptionInfoB64u = buildEncryptionInfo(
            privJwk.x!,
            privJwk.y!,
            nonce,
        ).toString("base64url");
        const transcript = await buildIsoMdocDcApiTranscript(
            encryptionInfoB64u,
            origin,
        );

        // Parse EncryptedResponse = ["dcapi", {"enc": bstr, "cipherText": bstr}]
        const encryptedBytes = Buffer.from(encryptedB64, "base64url");
        let encKey: Buffer;
        let ciphertext: Buffer;
        try {
            ({ enc: encKey, cipherText: ciphertext } =
                parseEncryptedResponse(encryptedBytes));
        } catch (err: any) {
            throw new BadRequestException(
                `Invalid EncryptedResponse: ${err?.message ?? err}`,
            );
        }

        let deviceResponseCbor: Buffer;
        try {
            deviceResponseCbor = hpkeOpen(
                encKey,
                ciphertext,
                { x: privJwk.x!, y: privJwk.y!, d: privJwk.d! },
                transcript.hpkeInfo,
            );
        } catch (err: any) {
            const reason = `HPKE decryption failed: ${err?.message ?? err}`;
            this.logger.warn({ sessionId }, reason);
            await this.failSession(session, {
                errorReason: reason,
                outcome: {
                    result: "failed",
                    message: "HPKE decryption failed",
                },
            });
            this.auditLogService.logFlowError(logContext, err as Error, {
                stage: "hpke_decryption",
            });
            throw new BadRequestException("HPKE decryption failed");
        }

        const config =
            await this.presentationConfigService.getPresentationConfig(
                session.requestId!,
                session.tenantId,
            );

        const mdocCred = config.dcql_query.credentials.find(
            (c) => c.format === "mso_mdoc",
        );
        if (!mdocCred) {
            throw new BadRequestException("No mso_mdoc credential in config");
        }

        // Build VerifierOptions from the credential's trusted_authorities config,
        // mirroring the trust validation applied in the OID4VP flow.
        const host = this.configService.getOrThrow<string>("PUBLIC_URL");
        const tenantHost = `${host}/issuers/${session.tenantId}`;

        const resolvedLoteAuthorities = await this.trustedAuthoritiesService
            .resolveTrustListRefsForTenant(
                trustListAuthorities(mdocCred.trusted_authorities),
                session.tenantId,
                tenantHost,
            )
            .catch((error: unknown) => {
                if (error instanceof InvalidTrustedAuthoritiesError) {
                    throw new BadRequestException(error.message);
                }
                throw error;
            });

        const verifyOptions: VerifierOptions = verifierTrustOptions({
            trustLists: resolvedLoteAuthorities,
            authorities: mdocCred.trusted_authorities,
            statusCheckMode:
                config.statusCheckMode ?? RevocationCheckMode.Strict,
            skewSeconds: session.skewSeconds ?? config.skewSeconds,
        });

        const deviceResponseB64 = deviceResponseCbor.toString("base64url");

        // Verify the mDOC using the pre-built DCAPIHandover transcript. The
        // requested elements are part of the DeviceRequest; a missing
        // element is not rejected separately in this flow.
        const verifyResult = await this.credentialVerifierFormats
            .resolve("mso_mdoc")
            .verify(deviceResponseB64, {
                credentialId: mdocCred.id,
                binding: {
                    protocol: "iso-18013-7",
                    sessionTranscript: transcript.sessionTranscript,
                },
                options: verifyOptions,
                claims: mdocCred.claims,
            });

        this.auditLogService.logCredentialVerification(
            logContext,
            verifyResult.verified,
            { docType: verifyResult.docType },
        );

        if (!verifyResult.verified) {
            // Machine-readable code + short message for the caller/UI; the
            // verbose failureReason (certificate subjects, thumbprints,
            // configured lists) is kept to logs/audit only.
            const { code: errorCode, message: shortMessage } =
                verificationFailureDetails(verifyResult.failure.type);
            const verboseReason =
                verifyResult.failure.reason ?? "mDOC verification failed";

            await this.failSession(session, {
                errorReason: shortMessage,
                failureCode: errorCode,
                outcome: {
                    result: "failed",
                    error: errorCode,
                    message: shortMessage,
                    credentials: [
                        {
                            id: mdocCred.id,
                            format: "mso_mdoc",
                            docType: verifyResult.docType,
                            verified: false,
                            error: errorCode,
                            message: shortMessage,
                        },
                    ],
                },
            });
            this.auditLogService.logFlowError(
                logContext,
                new Error(verboseReason),
                { stage: "mdoc_verification", errorCode },
            );
            throw new BadRequestException({
                error: errorCode,
                message: shortMessage,
            });
        }

        const credentials = [
            {
                id: mdocCred.id,
                format: "mso_mdoc",
                docType: verifyResult.docType,
                claims: verifyResult.claims,
            },
        ];

        const responseCode = randomUUID();
        const outcome: SessionOutcome = {
            result: "success",
            credentials: [
                {
                    id: mdocCred.id,
                    format: "mso_mdoc",
                    docType: verifyResult.docType,
                    verified: true,
                    trust: verifyResult.provenance,
                },
            ],
        };

        // Complete atomically with the single-use flag so a concurrent
        // response cannot also complete (and announce) the session.
        const completed = await this.sessionStore.updateIfUnconsumed(
            session.tenantId,
            session.id,
            {
                credentials: credentials as any,
                status: SessionStatus.Completed,
                responseCode,
                consumed: true,
                consumedAt: new Date(),
                outcome,
            },
        );
        if (!completed) {
            throw new BadRequestException(
                "The presentation offer has already been used",
            );
        }
        this.changeSessionState.announce(session, SessionStatus.Completed);

        const webhook = await this.resolveSessionWebhook(session);
        if (webhook) {
            const webhookResponse = await this.publishResult(webhook, session, {
                status: SessionStatus.Completed,
                outcome,
                credentials,
            });

            if (webhookResponse?.redirectUri) {
                session.redirectUri = webhookResponse.redirectUri;
            }
        }

        this.auditLogService.logFlowComplete(logContext, {
            credentialCount: credentials.length,
            webhookSent: !!webhook,
        });

        if (session.redirectUri) {
            const processedUri = decodeURIComponent(
                session.redirectUri,
            ).replaceAll("{sessionId}", session.id);
            const sep = processedUri.includes("?") ? "&" : "?";
            return {
                redirect_uri: `${processedUri}${sep}response_code=${responseCode}`,
            };
        }

        return {};
    }
}
