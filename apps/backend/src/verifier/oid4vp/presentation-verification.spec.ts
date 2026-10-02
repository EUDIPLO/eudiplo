import { BadRequestException, ConflictException } from "@nestjs/common";
import { base64url } from "jose";
import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../../session/domain/session-data.js";
import { MdocCredentialVerifierFormat } from "../presentations/adapters/mdoc-credential-verifier-format.js";
import { SdJwtCredentialVerifierFormat } from "../presentations/adapters/sd-jwt-credential-verifier-format.js";
import { CredentialVerifierFormatRegistry } from "../presentations/application/credential-verifier-format-registry.js";
import {
    CredentialVerificationFailedError,
    VerifyPresentationResponse,
} from "../presentations/application/verify-presentation-response.js";
import { SdJwtVerificationError } from "../presentations/credential/sdjwtvcverifier/sdjwtvcverifier.service.js";
import type { PresentationConfig } from "../presentations/entities/presentation-config.entity.js";
import { IncompletePresentationException } from "../presentations/exceptions/incomplete-presentation.exception.js";
import { InvalidTrustedAuthoritiesError } from "../presentations/ports/trust-list-ref-resolver.js";
import { Oid4vpService } from "./oid4vp.service.js";

/**
 * Characterizes presentation verification at the OID4VP service boundary:
 * the use case with the real format adapters over mocked format verifiers,
 * and the mapping of its errors to HTTP exceptions.
 */

const encode = (value: unknown) =>
    base64url.encode(Buffer.from(JSON.stringify(value)));

function requestObject(payload: Record<string, unknown>): string {
    return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

type DcqlCredential = {
    id: string;
    format: "dc+sd-jwt" | "mso_mdoc";
    claims?: Array<{ id?: string; path: string[] }>;
    claim_sets?: string[][];
    trusted_authorities?: unknown[];
};

function setup(
    credentials: DcqlCredential[],
    options: {
        session?: Partial<SessionData>;
        request?: Record<string, unknown>;
        sdJwtPayload?: Record<string, unknown>;
        mdocResult?: Record<string, unknown>;
        resolveTrustListRefs?: ReturnType<typeof vi.fn>;
    } = {},
) {
    const sdJwt = {
        verify: vi.fn().mockResolvedValue({
            payload: options.sdJwtPayload ?? {
                given_name: "Erika",
                cnf: { jwk: {} },
                status: {},
            },
        }),
    };
    const mdoc = {
        verify: vi.fn().mockResolvedValue(
            options.mdocResult ?? {
                verified: true,
                claims: { age_over_18: true },
                payload: "",
            },
        ),
    };
    const trustedAuthorities = {
        resolveTrustListRefsForTenant:
            options.resolveTrustListRefs ?? vi.fn().mockResolvedValue([]),
    };
    const logger = {
        setContext: vi.fn(),
        assign: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        warn: vi.fn(),
    };
    const verifyPresentationResponse = new VerifyPresentationResponse(
        new CredentialVerifierFormatRegistry([
            new SdJwtCredentialVerifierFormat(sdJwt as any, logger as any),
            new MdocCredentialVerifierFormat(mdoc as any, logger as any),
        ]),
        trustedAuthorities as any,
        { publicUrl: "https://eudiplo.example" },
    );
    const oid4vp = Object.assign(
        Object.create(Oid4vpService.prototype) as Oid4vpService,
        {
            verifyPresentationResponse,
            logger,
            traceService: { getSpan: () => undefined },
        },
    ) as unknown as {
        verifyPresentation: (
            res: unknown,
            config: PresentationConfig,
            session: SessionData,
        ) => Promise<unknown>;
    };
    const service = {
        parseResponse: (
            res: unknown,
            config: PresentationConfig,
            session: SessionData,
        ) => oid4vp.verifyPresentation(res, config, session),
    };
    const config = {
        tenantId: "tenant",
        dcql_query: { credentials },
    } as unknown as PresentationConfig;
    const session = {
        id: "session",
        tenantId: "tenant",
        vp_nonce: "nonce",
        clientId: "client",
        responseUri: "https://eudiplo.example/response",
        requestObject: requestObject({
            nonce: "request-nonce",
            client_id: "x509_hash:client",
            response_uri: "https://eudiplo.example/response",
            response_mode: "direct_post.jwt",
            dcql_query: { credentials },
            ...options.request,
        }),
        ...options.session,
    } as SessionData;
    return { service, config, session, sdJwt, mdoc, trustedAuthorities };
}

describe("OID4VP presentation verification", () => {
    it("rejects responses missing a required credential", async () => {
        const { service, config, session } = setup([
            { id: "pid", format: "dc+sd-jwt" },
            { id: "mdl", format: "mso_mdoc" },
        ]);
        const error = await service
            .parseResponse(
                { vp_token: { pid: ["vp"] } } as any,
                config,
                session,
            )
            .catch((e) => e);
        expect(error).toBeInstanceOf(IncompletePresentationException);
        expect(error.message).toBe("Missing required credentials: mdl");
    });

    it("rejects credential ids that are not in the config", async () => {
        const { service, config, session } = setup([], {});
        await expect(
            service.parseResponse(
                { vp_token: { other: ["vp"] } } as any,
                config,
                session,
            ),
        ).rejects.toThrow(
            new ConflictException("other not found in the presentation config"),
        );
    });

    it("verifies SD-JWT VCs with key binding and strips cnf and status", async () => {
        const { service, config, session, sdJwt } = setup([
            {
                id: "pid",
                format: "dc+sd-jwt",
                claims: [{ path: ["address", "locality"] }],
            },
        ]);

        await expect(
            service.parseResponse(
                { vp_token: { pid: ["vp"] } } as any,
                config,
                session,
            ),
        ).resolves.toEqual([
            {
                id: "pid",
                values: [
                    { given_name: "Erika", cnf: undefined, status: undefined },
                ],
            },
        ]);
        expect(sdJwt.verify).toHaveBeenCalledWith(
            "vp",
            expect.objectContaining({
                requiredClaimKeys: ["address.locality"],
                keyBindingNonce: "nonce",
                keyBindingAudience: "x509_hash:client",
                keyBindingResponseMode: "direct_post.jwt",
                skewSeconds: expect.any(Number),
            }),
        );
    });

    it("uses the expected origin as SD-JWT key binding audience for the DC API", async () => {
        const { service, config, session, sdJwt } = setup(
            [{ id: "pid", format: "dc+sd-jwt" }],
            {
                session: { useDcApi: true },
                request: { expected_origins: ["wallet.example/path"] },
            },
        );
        await service.parseResponse(
            { vp_token: { pid: ["vp"] } } as any,
            config,
            session,
        );
        expect(sdJwt.verify.mock.calls[0][1].keyBindingAudience).toBe(
            "origin:http://wallet.example",
        );
    });

    it("rejects SD-JWT VCs that satisfy no claim set", async () => {
        const { service, config, session } = setup([
            {
                id: "pid",
                format: "dc+sd-jwt",
                claims: [
                    { id: "a", path: ["age"] },
                    { id: "b", path: ["birthdate"] },
                ],
                claim_sets: [["a"], ["b"]],
            },
        ]);
        const error = await service
            .parseResponse(
                { vp_token: { pid: ["vp"] } } as any,
                config,
                session,
            )
            .catch((e) => e);
        expect(error).toBeInstanceOf(IncompletePresentationException);
        expect(error.message).toBe(
            'Credential "pid" does not satisfy any claim_set',
        );
    });

    it("rejects claim sets referencing unknown claims as a bad request", async () => {
        const { service, config, session } = setup([
            {
                id: "pid",
                format: "dc+sd-jwt",
                claims: [{ id: "a", path: ["age"] }],
                claim_sets: [["missing"]],
            },
        ]);
        await expect(
            service.parseResponse(
                { vp_token: { pid: ["vp"] } } as any,
                config,
                session,
            ),
        ).rejects.toThrow(
            new BadRequestException(
                "claim_sets references unknown claim id 'missing' for credential 'pid'",
            ),
        );
    });

    it("verifies mdocs with the OpenID4VP handover from the request object", async () => {
        const { service, config, session, mdoc } = setup([
            {
                id: "mdl",
                format: "mso_mdoc",
                claims: [{ path: ["org.iso.18013.5.1", "age_over_18"] }],
            },
        ]);
        await expect(
            service.parseResponse(
                { vp_token: { mdl: ["device-response"] } } as any,
                config,
                session,
            ),
        ).resolves.toEqual([{ id: "mdl", values: [{ age_over_18: true }] }]);
        expect(mdoc.verify).toHaveBeenCalledWith(
            "device-response",
            {
                protocol: "openid4vp",
                nonce: "request-nonce",
                clientId: "x509_hash:client",
                responseUri: "https://eudiplo.example/response",
                responseMode: "direct_post.jwt",
                jwkThumbprint: undefined,
            },
            expect.any(Object),
            [["org.iso.18013.5.1", "age_over_18"]],
        );
    });

    it("rejects mdocs missing a requested element", async () => {
        const { service, config, session } = setup([
            {
                id: "mdl",
                format: "mso_mdoc",
                claims: [{ path: ["org.iso.18013.5.1", "given_name"] }],
            },
        ]);
        const error = await service
            .parseResponse(
                { vp_token: { mdl: ["dr"] } } as any,
                config,
                session,
            )
            .catch((e) => e);
        expect(error).toBeInstanceOf(IncompletePresentationException);
        expect(error.message).toBe(
            "Missing required claims for credential 'mdl': org.iso.18013.5.1.given_name",
        );
    });

    it("maps mdoc verification failures to a short reason", async () => {
        const { service, config, session } = setup(
            [{ id: "mdl", format: "mso_mdoc" }],
            {
                mdocResult: {
                    verified: false,
                    claims: {},
                    docType: "org.iso.18013.5.1.mDL",
                    failureType: "trust_chain_not_trusted",
                    failureReason: "verbose details",
                },
            },
        );
        const error = await service
            .parseResponse(
                { vp_token: { mdl: ["dr"] } } as any,
                config,
                session,
            )
            .catch((e: any) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toBe(
            'mDOC verification failed for credential "mdl": certificate chain does not match any trusted entity',
        );
        // The structured failure travels as the cause for the session outcome.
        expect(error.cause).toBeInstanceOf(CredentialVerificationFailedError);
        expect(error.cause).toMatchObject({
            credentialId: "mdl",
            failure: {
                type: "trust_chain_not_trusted",
                reason: "verbose details",
            },
            credential: {
                format: "mso_mdoc",
                docType: "org.iso.18013.5.1.mDL",
            },
        });
    });

    it("reports classified SD-JWT VC failures like mdoc failures", async () => {
        const { service, config, session, sdJwt } = setup([
            { id: "pid", format: "dc+sd-jwt" },
        ]);
        sdJwt.verify.mockRejectedValue(
            new SdJwtVerificationError(
                "trust_chain_not_trusted",
                "verbose details",
            ),
        );
        const error = await service
            .parseResponse(
                { vp_token: { pid: ["vp"] } } as any,
                config,
                session,
            )
            .catch((e: any) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toBe(
            'SD-JWT VC verification failed for credential "pid": The credential issuer is not in the trusted list.',
        );
        expect(error.cause).toMatchObject({
            credentialId: "pid",
            failure: {
                type: "trust_chain_not_trusted",
                reason: "verbose details",
            },
            credential: { format: "dc+sd-jwt" },
        });
    });

    it("rejects incomplete trusted_authorities as a bad request", async () => {
        const { service, config, session } = setup(
            [{ id: "pid", format: "dc+sd-jwt" }],
            {
                resolveTrustListRefs: vi
                    .fn()
                    .mockRejectedValue(
                        new InvalidTrustedAuthoritiesError("invalid"),
                    ),
            },
        );
        await expect(
            service.parseResponse(
                { vp_token: { pid: ["vp"] } } as any,
                config,
                session,
            ),
        ).rejects.toThrow(new BadRequestException("invalid"));
    });
    it("rejects credentials of unsupported formats as a conflict", async () => {
        const { service, config, session } = setup([
            { id: "pid", format: "jwt_vc_json" as any },
        ]);
        await expect(
            service.parseResponse(
                { vp_token: { pid: ["vp"] } } as any,
                config,
                session,
            ),
        ).rejects.toThrow(
            new ConflictException("Unsupported credential type: jwt_vc_json"),
        );
    });

    it("passes SD-JWT VC verification errors through unchanged", async () => {
        const failure = new Error("KB-JWT nonce mismatch");
        const { service, config, session, sdJwt } = setup([
            { id: "pid", format: "dc+sd-jwt" },
        ]);
        sdJwt.verify.mockRejectedValue(failure);
        await expect(
            service.parseResponse(
                { vp_token: { pid: ["vp"] } } as any,
                config,
                session,
            ),
        ).rejects.toBe(failure);
    });

    it("verifies mdocs with the DC API handover", async () => {
        const { service, config, session, mdoc } = setup(
            [{ id: "mdl", format: "mso_mdoc" }],
            {
                session: { useDcApi: true },
                request: { expected_origins: ["https://wallet.example"] },
            },
        );
        await service.parseResponse(
            { vp_token: { mdl: ["dr"] } } as any,
            config,
            session,
        );
        expect(mdoc.verify.mock.calls[0][1]).toEqual({
            protocol: "dc_api",
            nonce: "request-nonce",
            origin: "https://wallet.example",
            jwkThumbprint: undefined,
        });
    });

    it("verifies each mdoc claim set option and reports the last failure", async () => {
        const { service, config, session, mdoc } = setup([
            {
                id: "mdl",
                format: "mso_mdoc",
                claims: [
                    { id: "a", path: ["ns", "age_over_18"] },
                    { id: "b", path: ["ns", "birth_date"] },
                ],
                claim_sets: [["a"], ["b"]],
            },
        ]);
        mdoc.verify
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValueOnce({
                verified: false,
                claims: {},
                failureType: "signature_invalid",
            });
        const error = await service
            .parseResponse(
                { vp_token: { mdl: ["dr"] } } as any,
                config,
                session,
            )
            .catch((e: any) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toBe(
            'mDOC verification failed for credential "mdl": mDOC signature is invalid',
        );
        expect(error.cause.failure.type).toBe("signature_invalid");
        expect(mdoc.verify.mock.calls.map((call) => call[3])).toEqual([
            [["ns", "age_over_18"]],
            [["ns", "birth_date"]],
        ]);
    });

    it("accepts the first mdoc claim set option that is disclosed", async () => {
        const { service, config, session } = setup([
            {
                id: "mdl",
                format: "mso_mdoc",
                claims: [
                    { id: "a", path: ["ns", "given_name"] },
                    { id: "b", path: ["ns", "age_over_18"] },
                ],
                claim_sets: [["a"], ["b"]],
            },
        ]);
        await expect(
            service.parseResponse(
                { vp_token: { mdl: ["dr"] } } as any,
                config,
                session,
            ),
        ).resolves.toEqual([{ id: "mdl", values: [{ age_over_18: true }] }]);
    });

    it("rejects mdocs that verify but satisfy no claim set", async () => {
        const { service, config, session } = setup([
            {
                id: "mdl",
                format: "mso_mdoc",
                claims: [{ id: "a", path: ["ns", "given_name"] }],
                claim_sets: [["a"]],
            },
        ]);
        const error = await service
            .parseResponse(
                { vp_token: { mdl: ["dr"] } } as any,
                config,
                session,
            )
            .catch((e) => e);
        expect(error).toBeInstanceOf(IncompletePresentationException);
        expect(error.message).toBe(
            'Credential "mdl" does not satisfy any claim_set',
        );
    });
});
