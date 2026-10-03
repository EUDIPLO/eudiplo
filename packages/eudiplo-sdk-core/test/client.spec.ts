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

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
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

  it("subscribes to session events under /api/session/:id/events", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { fetch } = createFetch(tokenRoute);
    const client = new EudiploClient({
      baseUrl,
      clientId: "client",
      clientSecret: "secret",
      fetch,
    });

    const subscription = await client.subscribeToSession("session-1");

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe(
      `${baseUrl}/api/session/session-1/events?token=token%20value`,
    );
    subscription.close();
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });

  it("resolves waitForSessionWithSse on a completed event", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { fetch } = createFetch(tokenRoute);
    const client = new EudiploClient({
      baseUrl,
      clientId: "client",
      clientSecret: "secret",
      fetch,
    });

    const result = client.waitForSessionWithSse("session-1");
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    expect(source.url).toBe(
      `${baseUrl}/api/session/session-1/events?token=token%20value`,
    );
    const event = {
      id: "session-1",
      status: "completed",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    source.onmessage?.({ data: JSON.stringify(event) });

    await expect(result).resolves.toEqual(event);
    expect(source.closed).toBe(true);
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
