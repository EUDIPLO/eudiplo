import { Module } from "@nestjs/common";
import { OutboundUrlPolicyService } from "./outbound-url-policy.service.js";

/**
 * Provides the outbound URL policy on its own, so modules that fetch remote
 * resources (trust lists, status lists, CRLs) can use it without importing
 * the webhook delivery and its session dependencies.
 */
@Module({
    providers: [OutboundUrlPolicyService],
    exports: [OutboundUrlPolicyService],
})
export class OutboundUrlPolicyModule {}
