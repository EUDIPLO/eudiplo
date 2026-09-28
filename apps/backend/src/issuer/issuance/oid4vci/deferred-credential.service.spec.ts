import type { HttpException } from "@nestjs/common";
import type { IssuerMetadataResult } from "@openid4vc/openid4vci";
import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../../../session/domain/session-data.js";
import { ResolveAuthorizedCredentialConfiguration } from "./application/resolve-authorized-credential-configuration.js";
import { ResolveDeferredCredentialRetrieval } from "./application/resolve-deferred-credential-retrieval.js";
import { DeferredCredentialService } from "./deferred-credential.service.js";
import { DeferredTransactionStatus } from "./domain/deferred-transaction-status.js";
import type { DeferredTransactionData } from "./ports/deferred-transaction.repository.js";

const proof = (payload: Record<string, unknown>) =>
    `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

const transaction: DeferredTransactionData = {
    transactionId: "tx",
    tenantId: "tenant",
    sessionId: "session",
    credentialConfigurationId: "pid",
    holderCnf: { kty: "EC" },
    status: DeferredTransactionStatus.Ready,
    credential: "credential-jwt",
    interval: 5,
    expiresAt: new Date(Date.now() + 60_000),
};

function setup(
    options: {
        holderKeys?: unknown[];
        nonceDeleted?: boolean;
        stored?: DeferredTransactionData | null;
        markRetrieved?: boolean;
        authorizationDetails?: unknown;
        belongsToSession?: boolean;
    } = {},
) {
    const transactions = {
        create: vi.fn(),
        find: vi.fn(async () =>
            options.stored === undefined ? transaction : options.stored,
        ),
        markRetrieved: vi.fn(async () => options.markRetrieved ?? true),
        markExpired: vi.fn(),
    };
    const verify = vi.fn(async () => options.holderKeys ?? [{ kty: "EC" }]);
    const prepare = vi.fn(async () => ({ verify }));
    const nonces = {
        delete: vi.fn(async () => options.nonceDeleted ?? true),
    };
    const accessTokens = {
        verify: vi.fn(async () => ({
            sub: "session",
            authorization_details: options.authorizationDetails,
        })),
    };
    const tokenSessions = {
        belongsToSession: vi.fn(async () => options.belongsToSession ?? true),
    };
    const service = new DeferredCredentialService(
        {
            getIssuanceConfiguration: vi.fn(async () => ({
                walletProviderTrustLists: ["trust-list"],
                dPopRequired: true,
            })),
        } as never,
        { getSpan: () => undefined } as never,
        accessTokens as never,
        nonces as never,
        { prepare },
        transactions as never,
        new ResolveDeferredCredentialRetrieval(),
        new ResolveAuthorizedCredentialConfiguration(),
        tokenSessions as never,
    );
    return {
        service,
        transactions,
        prepare,
        verify,
        nonces,
        accessTokens,
        tokenSessions,
    };
}

async function protocolError(promise: Promise<unknown>) {
    const error = await promise.then(
        () => {
            throw new Error("expected a rejection");
        },
        (e: HttpException) => e,
    );
    return error.getResponse();
}

describe("DeferredCredentialService.createDeferredTransaction", () => {
    const create = (
        service: DeferredCredentialService,
        proofType: "jwt" | "attestation",
        proofs = [proof({ nonce: "n-1" })],
    ) =>
        service.createDeferredTransaction({
            parsedCredentialRequest: {
                proofType,
                proofs,
                credentialConfigurationId: "pid",
            },
            session: { id: "session" } as SessionData,
            tenantId: "tenant",
            issuanceSetId: "set",
        });

    it("consumes the nonce, verifies the proof with the shared verifier and stores the holder key", async () => {
        const { service, transactions, prepare, verify, nonces } = setup();

        const response = await create(service, "jwt");

        expect(response).toEqual({
            transaction_id: expect.any(String),
            interval: 5,
        });
        expect(nonces.delete).toHaveBeenCalledWith("tenant", "n-1");
        expect(prepare).toHaveBeenCalledWith("tenant", ["trust-list"]);
        expect(verify).toHaveBeenCalledWith(expect.any(String), "jwt");
        expect(transactions.create).toHaveBeenCalledWith(
            expect.objectContaining({
                transactionId: response.transaction_id,
                tenantId: "tenant",
                sessionId: "session",
                credentialConfigurationId: "pid",
                issuanceSetId: "set",
                holderCnf: { kty: "EC" },
                status: DeferredTransactionStatus.Pending,
            }),
        );
    });

    it("rejects batches, missing nonces and reused nonces", async () => {
        expect(
            await protocolError(
                create(setup().service, "jwt", [proof({}), proof({})]),
            ),
        ).toEqual({
            error: "invalid_proof",
            error_description:
                "Deferred issuance requires exactly one key proof",
        });
        expect(
            await protocolError(create(setup().service, "jwt", [proof({})])),
        ).toMatchObject({ error: "invalid_proof" });
        const reused = setup({ nonceDeleted: false });
        expect(
            await protocolError(create(reused.service, "jwt")),
        ).toMatchObject({ error: "invalid_nonce" });
        expect(reused.prepare).not.toHaveBeenCalled();
    });

    it("requires exactly one attested key", async () => {
        const none = setup({ holderKeys: [] });
        expect(
            await protocolError(create(none.service, "attestation")),
        ).toEqual({
            error: "invalid_proof",
            error_description:
                "Attestation proof does not contain any attested keys",
        });
        const many = setup({ holderKeys: [{}, {}] });
        expect(
            await protocolError(create(many.service, "attestation")),
        ).toEqual({
            error: "invalid_proof",
            error_description:
                "Deferred issuance supports exactly one attested key",
        });
        expect(many.transactions.create).not.toHaveBeenCalled();
    });
});

describe("DeferredCredentialService.getDeferredCredential", () => {
    const request = {
        method: "POST",
        url: "/deferred_credential",
        headers: {},
        contentType: "application/json",
        body: {},
    };
    const metadata = {} as IssuerMetadataResult;
    const retrieve = (service: DeferredCredentialService) =>
        service.getDeferredCredential(
            request,
            { transaction_id: "tx" },
            "tenant",
            metadata,
        );

    it("returns a ready credential once and marks it retrieved", async () => {
        const { service, transactions, accessTokens } = setup();
        await expect(retrieve(service)).resolves.toEqual({
            credential: "credential-jwt",
        });
        expect(accessTokens.verify).toHaveBeenCalledWith(
            request,
            "tenant",
            metadata,
            true,
        );
        expect(transactions.markRetrieved).toHaveBeenCalledWith("tenant", "tx");
    });

    it("rejects a token of another session like an unknown transaction", async () => {
        const unknown = setup({ stored: null });
        const foreign = setup({ belongsToSession: false });
        const expected = await protocolError(retrieve(unknown.service));
        expect(await protocolError(retrieve(foreign.service))).toEqual(
            expected,
        );
        expect(expected).toEqual({
            error: "invalid_transaction_id",
            error_description: "The transaction_id is invalid or has expired",
        });
        expect(foreign.tokenSessions.belongsToSession).toHaveBeenCalledWith(
            "tenant",
            expect.objectContaining({ sub: "session" }),
            "session",
        );
        expect(foreign.transactions.markRetrieved).not.toHaveBeenCalled();
        expect(foreign.transactions.markExpired).not.toHaveBeenCalled();
    });

    it("checks the session before handling an expired transaction", async () => {
        const { service, transactions } = setup({
            belongsToSession: false,
            stored: { ...transaction, expiresAt: new Date(0) },
        });
        expect(await protocolError(retrieve(service))).toMatchObject({
            error_description: "The transaction_id is invalid or has expired",
        });
        expect(transactions.markExpired).not.toHaveBeenCalled();
    });

    it("rejects a concurrent second retrieval", async () => {
        const { service } = setup({ markRetrieved: false });
        expect(await protocolError(retrieve(service))).toEqual({
            error: "invalid_transaction_id",
            error_description: "The credential has already been retrieved",
        });
    });

    it("marks expired transactions and reports unknown ones", async () => {
        const expired = setup({
            stored: { ...transaction, expiresAt: new Date(0) },
        });
        expect(await protocolError(retrieve(expired.service))).toMatchObject({
            error: "invalid_transaction_id",
            error_description: "The transaction has expired",
        });
        expect(expired.transactions.markExpired).toHaveBeenCalledWith(
            "tenant",
            "tx",
        );

        const unknown = setup({ stored: null });
        expect(await protocolError(retrieve(unknown.service))).toMatchObject({
            error: "invalid_transaction_id",
        });
    });

    it("enforces the token's authorization_details", async () => {
        const { service, transactions } = setup({
            authorizationDetails: [
                {
                    type: "openid_credential",
                    credential_configuration_id: "other",
                },
            ],
        });
        expect(await protocolError(retrieve(service))).toEqual({
            error: "invalid_credential_request",
            error_description:
                "Access token is not authorized for credential_configuration_id 'pid'",
        });
        expect(transactions.markRetrieved).not.toHaveBeenCalled();
    });
});
