import { afterEach, describe, expect, it, vi } from "vitest";
import { EudiploClient } from "../src/client";

const baseUrl = "https://eudiplo.example";

function eventStream(...statuses: string[]): Response {
  const body = statuses
    .map(
      (status) =>
        `event: message\ndata: ${JSON.stringify({ id: "session-1", status, updatedAt: "2026-01-01T00:00:00.000Z" })}\n\n`,
    )
    .join("");
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** Answers the token endpoint and hands every event stream request to `events`. */
function createClient(events: (request: Request) => Response) {
  const eventRequests: Request[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    if (request.url === `${baseUrl}/api/oauth2/token`) {
      return Response.json({ access_token: "access-token", expires_in: 3600 });
    }
    eventRequests.push(request);
    return events(request);
  });
  const client = new EudiploClient({
    baseUrl,
    clientId: "client",
    clientSecret: "secret",
    fetch: fetch as typeof globalThis.fetch,
  });
  return { client, eventRequests };
}

describe("session events", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the access token in the Authorization header, not in the URL", async () => {
    const { client, eventRequests } = createClient(() =>
      eventStream("active", "completed"),
    );

    await expect(client.waitForSessionWithSse("session-1")).resolves.toMatchObject({
      id: "session-1",
      status: "completed",
    });
    expect(eventRequests).toHaveLength(1);
    expect(eventRequests[0].url).toBe(`${baseUrl}/api/session/session-1/events`);
    expect(eventRequests[0].headers.get("Authorization")).toBe("Bearer access-token");
  });

  it("rejects when the session fails", async () => {
    const { client } = createClient(() => eventStream("active", "failed"));

    await expect(client.waitForSessionWithSse("session-1")).rejects.toThrow(
      "Session failed: session-1",
    );
  });

  it("stops retrying a refused stream after three attempts", async () => {
    vi.useFakeTimers();
    const { client, eventRequests } = createClient(
      () => new Response("Not Found", { status: 404, statusText: "Not Found" }),
    );

    const result = client.waitForSessionWithSse("session-1");
    const assertion = expect(result).rejects.toThrow(
      "Session event stream for session-1 ended before a final status: SSE failed: 404 Not Found",
    );
    await vi.runAllTimersAsync();
    await assertion;
    expect(eventRequests).toHaveLength(3);
  });

  it("reports the opened stream and every status to a subscriber", async () => {
    const { client } = createClient(() => eventStream("active", "completed"));
    const onOpen = vi.fn();
    const onError = vi.fn();
    const statuses: string[] = [];

    await new Promise<void>((resolve) => {
      void client.subscribeToSession("session-1", {
        onOpen,
        onError,
        onStatusChange: (event) => {
          statuses.push(event.status);
          if (event.status === "completed") resolve();
        },
      });
    });

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(["active", "completed"]);
    expect(onError).not.toHaveBeenCalled();
  });
});
