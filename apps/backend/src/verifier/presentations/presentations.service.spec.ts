import { BadRequestException, ConflictException } from "@nestjs/common";
import { base64url } from "jose";
import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../../session/domain/session-data.js";
import { CredentialVerifierFormatRegistry } from "./credential/credential-verifier-format-registry.js";
import type { PresentationConfig } from "./entities/presentation-config.entity.js";
import { IncompletePresentationException } from "./exceptions/incomplete-presentation.exception.js";
import { PresentationsService } from "./presentations.service.js";
import { InvalidTrustedAuthoritiesError } from "./trusted-authorities.service.js";

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
        format: "dc+sd-jwt" as const,
        verify: vi.fn().mockResolvedValue({
            payload: options.sdJwtPayload ?? {
                given_name: "Erika",
                cnf: { jwk: {} },
                status: {},
            },
        }),
    };
    const mdoc = {
        format: "mso_mdoc" as const,
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
    const service = new PresentationsService(
        new CredentialVerifierFormatRegistry([sdJwt, mdoc] as any),
        { publicUrl: "https://eudiplo.example" },
        trustedAuthorities as any,
        logger as any,
        { getSpan: () => undefined } as any,
    );
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

describe("PresentationsService.parseResponse", () => {
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
                    failureType: "trust_chain_not_trusted",
                    failureReason: "verbose details",
                },
            },
        );
        await expect(
            service.parseResponse(
                { vp_token: { mdl: ["dr"] } } as any,
                config,
                session,
            ),
        ).rejects.toThrow(
            new BadRequestException(
                'mDOC verification failed for credential "mdl": certificate chain does not match any trusted entity',
            ),
        );
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
});
