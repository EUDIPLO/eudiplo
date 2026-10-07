import { describe, expect, it } from "vitest";
import { NotificationRequestDto } from "./notification-request.dto.js";

const parse = (body: Record<string, unknown>) =>
    NotificationRequestDto.schema.safeParse(body);

describe("NotificationRequestDto", () => {
    const request = {
        notification_id: "notification-1",
        event: "credential_failure",
    };

    it("accepts the optional event_description of OID4VCI", () => {
        expect(
            parse({
                ...request,
                event_description: "Could not store the credential: [E42] ~!",
            }).data,
        ).toEqual({
            ...request,
            event_description: "Could not store the credential: [E42] ~!",
        });
        expect(parse(request).data).toEqual(request);
    });

    it.each([
        ["a double quote", 'Storage "full"'],
        ["a backslash", "C:\\wallet"],
        ["a line break", "first\nsecond"],
        ["a non-ASCII character", "Speicher voll für Max"],
    ])("rejects an event_description with %s", (_case, description) => {
        expect(
            parse({ ...request, event_description: description }).success,
        ).toBe(false);
    });

    it("ignores unrecognized parameters", () => {
        expect(parse({ ...request, wallet_extension: true }).data).toEqual(
            request,
        );
    });

    it("still requires a known event", () => {
        expect(parse({ ...request, event: "credential_lost" }).success).toBe(
            false,
        );
        expect(parse({ event: "credential_accepted" }).success).toBe(false);
    });
});
