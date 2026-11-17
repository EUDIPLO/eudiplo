import { webcrypto, X509Certificate } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OutboundFetchError } from "../../webhook/outbound-fetch.js";
import { EudiHubClient, EudiHubRequestError } from "./eudi-hub.client.js";

const fetchMock = vi.fn();

vi.mock("../../webhook/outbound-fetch.js", async (importOriginal) => ({
    ...(await importOriginal<
        typeof import("../../webhook/outbound-fetch.js")
    >()),
    outboundFetch: () => fetchMock,
}));

const TOKEN = "eyJhbGciOi.secret-token.sig";
const ORG = "01932c5a-9abc-7000-8000-000000000010";
/** A compact JWS with a JSON payload; the client does not check signatures. */
const PAYLOAD_JWT = `eyJhbGciOiJFUzI1NiJ9.${Buffer.from('{"sub":"x"}').toString("base64url")}.c2ln`;

function client(
    url = "https://api.eudi-hub.gov.de/org-management",
): EudiHubClient {
    const config = { getOrThrow: vi.fn().mockReturnValue(url) };
    return new EudiHubClient(config as any, {} as any, {} as any);
}

function json(status: number, body: unknown, type = "application/json") {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": type },
    });
}

describe("EudiHubClient", () => {
    beforeEach(() => {
        fetchMock.mockReset();
    });

    it("sends the token as bearer to the configured URL", async () => {
        fetchMock.mockResolvedValue(
            json(200, {
                organizations: [
                    { id: ORG, name: "Org" },
                    { id: 1, name: "broken" },
                ],
            }),
        );

        const organizations = await client(
            "https://hub.example/org-management/",
        ).listOrganizations(TOKEN);

        expect(organizations).toEqual([{ id: ORG, name: "Org" }]);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("https://hub.example/org-management/v1/me");
        expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    });

    it("turns the downloaded DER into PEM", async () => {
        const keys = (await webcrypto.subtle.generateKey(
            { name: "ECDSA", namedCurve: "P-256" },
            true,
            ["sign", "verify"],
        )) as CryptoKeyPair;
        const cert = await x509.X509CertificateGenerator.createSelfSigned(
            {
                serialNumber: "01",
                name: "CN=hub",
                keys,
                signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
            },
            webcrypto as Crypto,
        );
        fetchMock.mockResolvedValue(
            new Response(cert.rawData, {
                status: 200,
                headers: { "content-type": "application/pkix-cert" },
            }),
        );

        const pem = await client().downloadAccessCertificate(
            TOKEN,
            ORG,
            "cert-1",
        );

        expect(new X509Certificate(pem).subject).toBe("CN=hub");
        expect(fetchMock.mock.calls[0][0]).toBe(
            `https://api.eudi-hub.gov.de/org-management/v1/organizations/${ORG}/access-certificates/cert-1/download`,
        );
    });

    it("reports the status and problem detail of a refusal without the token", async () => {
        fetchMock.mockResolvedValue(
            json(
                403,
                { title: "Forbidden", detail: "Missing scope" },
                "application/problem+json",
            ),
        );

        const error = await client()
            .createAccessCertificate(TOKEN, ORG, {
                name: "n",
                csr: "csr",
                environment: "sandbox",
                supportUri: "https://s.example",
            })
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(EudiHubRequestError);
        expect(error).toMatchObject({ status: 403, detail: "Missing scope" });
        expect(JSON.stringify(error)).not.toContain(TOKEN);
        expect((error as Error).message).not.toContain(TOKEN);
    });

    it("marks a request the outbound URL policy blocked", async () => {
        fetchMock.mockRejectedValue(
            new OutboundFetchError("blocked host", { blocked: true }),
        );

        const error = await client()
            .listOrganizations(TOKEN)
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(EudiHubRequestError);
        expect((error as EudiHubRequestError).blocked).toBe(true);
        expect((error as EudiHubRequestError).status).toBeUndefined();
    });

    it("revokes for cessation of operation", async () => {
        fetchMock.mockResolvedValue(json(200, {}));

        await client().revokeAccessCertificate(TOKEN, ORG, "cert-1");

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toMatch(/\/access-certificates\/cert-1\/revoke$/);
        expect(JSON.parse(init.body)).toEqual({
            revocationReason: "cessationOfOperation",
        });
    });

    it.each([
        [
            "no list of organizations",
            () => client().listOrganizations(TOKEN),
            {},
        ],
        [
            "an access certificate without id, name or status",
            () =>
                client().createAccessCertificate(TOKEN, ORG, {
                    name: "n",
                    csr: "csr",
                    environment: "sandbox",
                    supportUri: "https://s.example",
                }),
            { id: "x" },
        ],
        [
            "no list of access certificates",
            () => client().listAccessCertificates(TOKEN, ORG, "sandbox"),
            {},
        ],
    ])("reports an answer with %s as invalid", async (_, call, body) => {
        fetchMock.mockResolvedValue(json(201, body));

        const error = await call().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(EudiHubRequestError);
        expect((error as EudiHubRequestError).invalidAnswer).toBe(true);
    });

    it("reports a 2xx answer without JSON as invalid", async () => {
        fetchMock.mockResolvedValue(new Response("<html>", { status: 200 }));

        await expect(client().listOrganizations(TOKEN)).rejects.toThrow(
            "The EUDI Hub answered GET /v1/me without JSON",
        );
    });

    it("reports a download that is not a certificate as invalid", async () => {
        fetchMock.mockResolvedValue(new Response("<html>", { status: 200 }));

        const error = await client()
            .downloadAccessCertificate(TOKEN, ORG, "cert-1")
            .catch((e: unknown) => e);

        expect((error as EudiHubRequestError).invalidAnswer).toBe(true);
    });

    it("lists the certificates of an environment without the query in errors", async () => {
        fetchMock.mockResolvedValue(json(500, {}));

        const error = await client()
            .listAccessCertificates(TOKEN, ORG, "live")
            .catch((e: unknown) => e);

        expect(fetchMock.mock.calls[0][0]).toBe(
            `https://api.eudi-hub.gov.de/org-management/v1/organizations/${ORG}/access-certificates?environment=live&limit=100`,
        );
        expect((error as Error).message).toBe(
            `The EUDI Hub answered GET /v1/organizations/${ORG}/access-certificates with HTTP 500`,
        );
    });

    it("falls back to the problem title and shortens the detail", async () => {
        fetchMock.mockResolvedValueOnce(
            json(400, { title: "Bad  \n Request" }),
        );
        const titled = await client()
            .listOrganizations(TOKEN)
            .catch((e: unknown) => e);
        expect((titled as EudiHubRequestError).detail).toBe("Bad Request");

        fetchMock.mockResolvedValueOnce(
            json(400, { detail: "x".repeat(1000) }),
        );
        const long = await client()
            .listOrganizations(TOKEN)
            .catch((e: unknown) => e);
        expect((long as EudiHubRequestError).detail).toHaveLength(300);
    });

    it("encodes a certificate ID from the EUDI Hub in the path", async () => {
        fetchMock.mockResolvedValue(json(200, {}));

        await client().revokeAccessCertificate(TOKEN, ORG, "../x");

        expect(fetchMock.mock.calls[0][0]).toContain(
            "/access-certificates/..%2Fx/revoke",
        );
    });

    it("reports a request that failed otherwise as not reached", async () => {
        fetchMock.mockRejectedValue(new TypeError("socket hang up"));

        const error = await client()
            .listOrganizations(TOKEN)
            .catch((e: unknown) => e);

        expect(error).toMatchObject({
            message:
                "The EUDI Hub could not be reached: TypeError: socket hang up",
        });
        expect((error as EudiHubRequestError).status).toBeUndefined();
        expect((error as EudiHubRequestError).blocked).toBe(false);
    });

    it("reads identifiers, service descriptions and contact data of an organization", async () => {
        fetchMock.mockResolvedValue(
            json(200, {
                id: ORG,
                name: "Example GmbH",
                tradeName: "Example",
                serviceDescription: [
                    {
                        id: "sd-1",
                        name: "General",
                        descriptions: [
                            { lang: "de", content: "Dienst" },
                            { lang: "en", content: "Service" },
                            { lang: 3 },
                        ],
                    },
                ],
                legalInformation: {
                    identifier: [
                        {
                            type: "http://data.europa.eu/eudi/id/EUID",
                            value: "DE/HRB1",
                        },
                        { type: "broken" },
                    ],
                    privacyPolicyUris: ["https://example.com/privacy"],
                },
                contactInformation: {
                    supportUris: ["https://example.com/support"],
                    infoUris: ["https://example.com"],
                },
            }),
        );

        const organization = await client().getOrganization(TOKEN, ORG);

        expect(organization).toEqual({
            id: ORG,
            name: "Example",
            identifiers: [
                {
                    type: "http://data.europa.eu/eudi/id/EUID",
                    value: "DE/HRB1",
                },
            ],
            serviceDescriptions: [
                {
                    name: "General",
                    descriptions: [
                        { lang: "de", content: "Dienst" },
                        { lang: "en", content: "Service" },
                    ],
                },
            ],
            privacyPolicyUris: ["https://example.com/privacy"],
            supportUris: ["https://example.com/support"],
            infoUris: ["https://example.com"],
        });
        expect(fetchMock.mock.calls[0][0]).toBe(
            `https://api.eudi-hub.gov.de/org-management/v1/organizations/${ORG}`,
        );
    });

    it("downloads a registration certificate as a JWT", async () => {
        fetchMock.mockResolvedValue(
            new Response(`${PAYLOAD_JWT}\n`, {
                status: 200,
                headers: { "content-type": "application/jwt" },
            }),
        );

        await expect(
            client().downloadRegistrationCertificate(TOKEN, ORG, "rc-1"),
        ).resolves.toBe(PAYLOAD_JWT);
        expect(fetchMock.mock.calls[0][0]).toMatch(
            /\/registration-certificates\/rc-1\/download$/,
        );
    });

    it.each([
        ["HTML", "<html>"],
        ["a payload that is no JSON", "aaa.bbb.ccc"],
    ])(
        "reports a registration certificate download with %s as invalid",
        async (_, body) => {
            fetchMock.mockResolvedValue(new Response(body, { status: 200 }));

            const error = await client()
                .downloadRegistrationCertificate(TOKEN, ORG, "rc-1")
                .catch((e: unknown) => e);

            expect((error as EudiHubRequestError).invalidAnswer).toBe(true);
        },
    );

    it("reports a created resource without id as invalid", async () => {
        fetchMock.mockResolvedValue(json(201, { name: "x" }));

        const error = await client()
            .createCredentialRequest(TOKEN, ORG, {
                name: "x",
                purpose: [],
                credentials: [],
                privacyPolicy: "https://p.example",
                environments: ["sandbox"],
            })
            .catch((e: unknown) => e);

        expect((error as EudiHubRequestError).invalidAnswer).toBe(true);
    });

    it("skips list entries without an id", async () => {
        fetchMock.mockResolvedValue(
            json(200, { items: [{ id: "cr-1" }, { name: "broken" }] }),
        );

        const requests = await client().listCredentialRequests(
            TOKEN,
            ORG,
            "sandbox",
        );

        expect(requests.map(({ id }) => id)).toEqual(["cr-1"]);
    });
});
