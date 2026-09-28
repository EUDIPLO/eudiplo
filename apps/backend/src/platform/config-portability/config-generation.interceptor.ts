import {
    CallHandler,
    ExecutionContext,
    Injectable,
    NestInterceptor,
} from "@nestjs/common";
import type { Request } from "express";
import { defer, lastValueFrom, type Observable } from "rxjs";
import type { TokenPayload } from "../../auth/token.decorator.js";
import { ConfigImportJournalService } from "./config-import-journal.service.js";
import { ConfigOwnershipService } from "./config-ownership.service.js";
import { ConfigResourceRouteService } from "./config-resource-route.service.js";

@Injectable()
export class ConfigGenerationInterceptor implements NestInterceptor {
    constructor(
        private readonly ownershipService: ConfigOwnershipService,
        private readonly routeService: ConfigResourceRouteService,
        private readonly journal: ConfigImportJournalService,
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
        const tenantId = match?.tenantId ?? request.user?.entity?.id;
        if (!tenantId) return next.handle();
        const assetUpload =
            request.method === "POST" &&
            /^\/(?:api\/)?storage\/?$/.test(request.path);
        if (!match && !assetUpload) return next.handle();
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
                            request.method === "DELETE"
                                ? "delete-ownership"
                                : "ownership",
                        kind: match.kind,
                        id: match.id,
                        status: "running",
                    });
                    await this.journal.checkpoint(run);
                    if (request.method === "DELETE") {
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
