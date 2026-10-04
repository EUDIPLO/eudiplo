import { afterEach, describe, expect, it, vi } from "vitest";
import { EudiploClient } from "../src/client";

/**
 * The backend serves the management API under the global `/api` prefix and
 * the wallet-facing protocol routes (e.g. `presentations/:id/oid4vp/...`) and
 * `/health` at the root. These tests pin the exact URLs the hand-written
 * parts of the client use.
 */

const baseUrl = "https://eudiplo.example.com";

interface RecordedRequest {
  method: string;
  url: string;
}

type Route = (request: RecordedRequest) => Response | undefined;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createFetch(routes: Record<string, Route | Response>) {
  const requests: RecordedRequest[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request
          ? { method: input.method, url: input.url }
          : {
              method: init?.method ?? "GET",
              url: input instanceof URL ? input.href : String(input),
            };
      requests.push(request);
      const route = routes[`${request.method} ${request.url}`];
      const response =
        typeof route === "function" ? route(request) : route?.clone();
      return response ?? json({ message: "Not Found" }, 404);
    },
  );
  return { fetch: fetchMock as unknown as typeof fetch, requests };
}

const tokenRoute = {
  [`POST ${baseUrl}/api/oauth2/token`]: json({
    access_token: "token value",
    expires_in: 3600,
  }),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EudiploClient URLs", () => {
  it("requests the token from /api/oauth2/token", async () => {
    const { fetch, requests } = createFetch(tokenRoute);
    const client = new EudiploClient({
      baseUrl,
      clientId: "client",
      clientSecret: "secret",
      fetch,
    });

    await client.authenticate();

    expect(requests).toEqual([
      { method: "POST", url: `${baseUrl}/api/oauth2/token` },
    ]);
  });

  it("strips a trailing slash from the base URL", async () => {
    const { fetch, requests } = createFetch(tokenRoute);
    const client = new EudiploClient({
      baseUrl: `${baseUrl}/`,
      clientId: "client",
      clientSecret: "secret",
      fetch,
    });

    await client.authenticate();

    expect(client.getBaseUrl()).toBe(baseUrl);
    expect(requests[0].url).toBe(`${baseUrl}/api/oauth2/token`);
  });

  it("reads health from the unprefixed /health endpoint", async () => {
    const { fetch, requests } = createFetch({
      [`GET ${baseUrl}/health`]: json({ status: "ok" }),
    });
    const client = new EudiploClient({
      baseUrl,
      clientId: "client",
      clientSecret: "secret",
      fetch,
    });

    expect(await client.getHealth()).toEqual({ status: "ok" });
    expect(requests).toEqual([{ method: "GET", url: `${baseUrl}/health` }]);
  });

  it("streams session events from /api/session/:id/events without a token in the URL", async () => {
    const event = {
      id: "session-1",
      status: "completed",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const { fetch, requests } = createFetch({
      ...tokenRoute,
      [`GET ${baseUrl}/api/session/session-1/events`]: new Response(
        `data: ${JSON.stringify(event)}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    });
    const client = new EudiploClient({
      baseUrl,
      clientId: "client",
      clientSecret: "secret",
      fetch,
    });

    await expect(client.waitForSessionWithSse("session-1")).resolves.toEqual(
      event,
    );
    expect(requests).toContainEqual({
      method: "GET",
      url: `${baseUrl}/api/session/session-1/events`,
    });
  });

  it("fetches a missing DC API request object from the unprefixed wallet endpoint", async () => {
    const requestObject = "header.payload.signature";
    const { fetch, requests } = createFetch({
      ...tokenRoute,
      [`POST ${baseUrl}/api/verifier/offer`]: json({
        uri: "openid4vp://?request_uri=x",
        session: "session-1",
      }),
      [`GET ${baseUrl}/api/session/session-1`]: json({
        id: "session-1",
        walletNonce: "wallet nonce",
        status: "active",
      }),
      [`GET ${baseUrl}/presentations/wallet%20nonce/oid4vp/request`]:
        new Response(requestObject, {
          headers: { "Content-Type": "application/oauth-authz-req+jwt" },
        }),
    });
    const client = new EudiploClient({
      baseUrl,
      clientId: "client",
      clientSecret: "secret",
      fetch,
    });

    const session = await client.createDcApiPresentationRequest({
      configId: "age-over-18",
      origin: "https://rp.example.com",
    });

    expect(session.requestObject).toBe(requestObject);
    expect(requests).toEqual([
      { method: "POST", url: `${baseUrl}/api/oauth2/token` },
      { method: "POST", url: `${baseUrl}/api/verifier/offer` },
      { method: "GET", url: `${baseUrl}/api/session/session-1` },
      {
        method: "GET",
        url: `${baseUrl}/presentations/wallet%20nonce/oid4vp/request`,
      },
    ]);
  });

  it("uses the stored request object without fetching it again", async () => {
    const { fetch, requests } = createFetch({
      ...tokenRoute,
      [`POST ${baseUrl}/api/verifier/offer`]: json({
        uri: "openid4vp://?request_uri=x",
        session: "session-1",
      }),
      [`GET ${baseUrl}/api/session/session-1`]: json({
        id: "session-1",
        status: "active",
        requestObject: "stored.request.object",
      }),
    });
    const client = new EudiploClient({
      baseUrl,
      clientId: "client",
      clientSecret: "secret",
      fetch,
    });

    const session = await client.createDcApiPresentationRequest({
      configId: "age-over-18",
      origin: "https://rp.example.com",
    });

    expect(session.requestObject).toBe("stored.request.object");
    expect(requests.map((request) => request.url)).toEqual([
      `${baseUrl}/api/oauth2/token`,
      `${baseUrl}/api/verifier/offer`,
      `${baseUrl}/api/session/session-1`,
    ]);
  });
});
