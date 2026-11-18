import {
    CallHandler,
    ExecutionContext,
    Inject,
    Injectable,
    NestInterceptor,
} from "@nestjs/common";
import type { Request } from "express";
import { defer, lastValueFrom, type Observable, switchMap } from "rxjs";
import {
    CLIENTS_PROVIDER,
    ClientsProvider,
} from "../../auth/client/client.provider.js";
import { rotatesSecretsOfAnyTenant } from "../../auth/client/client-access.service.js";
import type { TokenPayload } from "../../auth/token.decorator.js";
import { ConfigImportJournalService } from "./config-import-journal.service.js";
import { ConfigOwnershipService } from "./config-ownership.service.js";
import {
    type ConfigResourceRouteMatch,
    ConfigResourceRouteService,
} from "./config-resource-route.service.js";

@Injectable()
export class ConfigGenerationInterceptor implements NestInterceptor {
    constructor(
        private readonly ownershipService: ConfigOwnershipService,
        private readonly routeService: ConfigResourceRouteService,
        private readonly journal: ConfigImportJournalService,
        @Inject(CLIENTS_PROVIDER) private readonly clients: ClientsProvider,
    ) {}

    intercept(
        context: ExecutionContext,
        next: CallHandler,
    ): Observable<unknown> {
        const request = context
            .switchToHttp()
            .getRequest<Request & { user?: TokenPayload }>();
        if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
            return next.handle();
        }
        const match = this.routeService.match(
            request.method,
            request.path,
            request.body as Record<string, unknown>,
        );
        const assetUpload =
            request.method === "POST" &&
            /^\/(?:api\/)?storage\/?$/.test(request.path);
        if (!match && !assetUpload) return next.handle();
        // A tenant manager reaches a client of any tenant, so the client's own
        // tenant decides whether it is file-managed, not the caller's.
        if (
            match?.kind === "Client" &&
            match.crossTenant &&
            rotatesSecretsOfAnyTenant(request.user?.roles)
        ) {
            return defer(() => this.clients.getClientById(match.id)).pipe(
                switchMap((client) =>
                    this.track(
                        client?.tenantId ?? undefined,
                        match,
                        assetUpload,
                        request.method,
                        next,
                    ),
                ),
            );
        }
        return this.track(
            match?.tenantId ?? request.user?.entity?.id,
            match,
            assetUpload,
            request.method,
            next,
        );
    }

    /**
     * Refuses to change a file-managed resource of the tenant and records the
     * change; without a tenant there is nothing to protect or record.
     */
    private track(
        tenantId: string | undefined,
        match: ConfigResourceRouteMatch | undefined,
        assetUpload: boolean,
        method: string,
        next: CallHandler,
    ): Observable<unknown> {
        if (!tenantId) return next.handle();
        return defer(() =>
            this.journal.run(tenantId, "api", async (run) => {
                if (match)
                    await this.ownershipService.assertMutable(
                        tenantId,
                        match.kind,
                        match.id,
                    );
                run.operations = [
                    {
                        stage: assetUpload ? "asset" : "resource",
                        kind: match?.kind,
                        id: match?.id,
                        status: "running",
                    },
                ];
                await this.journal.checkpoint(run);
                const result = await lastValueFrom(next.handle());
                run.operations[0].status = "completed";
                if (match) {
                    run.operations.push({
                        stage:
                            method === "DELETE"
                                ? "delete-ownership"
                                : "ownership",
                        kind: match.kind,
                        id: match.id,
                        status: "running",
                    });
                    await this.journal.checkpoint(run);
                    if (method === "DELETE") {
                        if (match.kind === "Tenant")
                            await this.ownershipService.removeTenant(tenantId);
                        else
                            await this.ownershipService.remove(
                                tenantId,
                                match.kind,
                                match.id,
                            );
                    } else
                        await this.ownershipService.recordApiMutation(
                            tenantId,
                            match.kind,
                            match.id,
                            match.create,
                        );
                }
                if (match) run.operations[1].status = "completed";
                return result;
            }),
        );
    }
}
