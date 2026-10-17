import { HttpService } from "@nestjs/axios";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { OutboundUrlPolicyService } from "../webhook/outbound-url-policy.service.js";
import { HttpFederationResolver } from "./adapters/http-federation-resolver.js";
import { LocalFederationResolver } from "./adapters/local-federation-resolver.js";
import {
    FEDERATION_RESOLVER_SETTINGS,
    type FederationResolverSettings,
} from "./federation-resolver-settings.js";
import { FEDERATION_RESOLVER } from "./ports/federation-resolver.js";
import { federationResolverProvider } from "./trust.module.js";
import { TrustFetchService } from "./trust-fetch.service.js";

describe("TrustModule wiring", () => {
    async function resolverFor(settings: FederationResolverSettings) {
        const moduleRef = await Test.createTestingModule({
            providers: [
                { provide: FEDERATION_RESOLVER_SETTINGS, useValue: settings },
                { provide: TrustFetchService, useValue: { get: () => {} } },
                { provide: HttpService, useValue: {} },
                { provide: OutboundUrlPolicyService, useValue: {} },
                federationResolverProvider,
            ],
        }).compile();
        return moduleRef.get(FEDERATION_RESOLVER);
    }

    it("resolves trust chains locally by default", async () => {
        await expect(
            resolverFor({ type: "local", clockToleranceSeconds: 5 }),
        ).resolves.toBeInstanceOf(LocalFederationResolver);
    });

    it("delegates to a trust engine with FEDERATION_RESOLVER=http", async () => {
        await expect(
            resolverFor({ type: "http", url: "https://trust-engine.example" }),
        ).resolves.toBeInstanceOf(HttpFederationResolver);
    });
});
