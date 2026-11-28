import { type ArgumentsHost, Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KmsCredentialError } from "./kms/kms-credential-error.js";
import { KmsCredentialErrorFilter } from "./kms-credential-error.filter.js";

function respond(error: KmsCredentialError) {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const host = {
        switchToHttp: () => ({
            getResponse: () => ({ status }),
            getRequest: () => ({
                method: "POST",
                path: "/key-chain",
                url: "/key-chain",
            }),
        }),
    } as unknown as ArgumentsHost;
    new KmsCredentialErrorFilter().catch(error, host);
    return { status: status.mock.calls[0][0], body: json.mock.calls[0][0] };
}

describe("KmsCredentialErrorFilter", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const cause = new Error(
        "${vault:kv/operator/kms#token} is refused: tenant 'acme' may send it only to https://vault.example",
    );

    it("answers 409 for credentials the configuration must change, naming no reference", () => {
        const { status, body } = respond(
            new KmsCredentialError("own-kms", "refused", { cause }),
        );
        expect(status).toBe(409);
        expect(body.message).toMatch(/KMS provider 'own-kms' cannot be used/);
        expect(JSON.stringify(body)).not.toMatch(/vault:|vault\.example/);
    });

    it("answers 503 while a secret source does not answer", () => {
        const { status, body } = respond(
            new KmsCredentialError("own-kms", "unavailable", { cause }),
        );
        expect(status).toBe(503);
        expect(body.message).toMatch(/cannot be read/);
        expect(JSON.stringify(body)).not.toMatch(/vault:/);
    });
});
