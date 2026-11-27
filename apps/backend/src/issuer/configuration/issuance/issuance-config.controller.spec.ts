import { describe, expect, it, vi } from "vitest";
import { Role } from "../../../auth/roles/role.enum.js";
import type { TokenPayload } from "../../../auth/token.decorator.js";
import type { IssuanceService } from "./issuance.service.js";
import { IssuanceConfigController } from "./issuance-config.controller.js";

function controller() {
    const service = {
        getIssuanceConfigurationOrDefault: vi
            .fn()
            .mockResolvedValue({ tenantId: "t1", authorizationServers: [] }),
    };
    const secrets = { isReference: () => false } as never;
    return {
        service,
        controller: new IssuanceConfigController(
            service as unknown as IssuanceService,
            secrets,
        ),
    };
}

const token = (roles: Role[]) =>
    ({ entity: { id: "t1" }, roles }) as unknown as TokenPayload;

describe("IssuanceConfigController.getIssuanceConfigurations", () => {
    it("asks for the default without storing it for a caller that only reads", async () => {
        const { service, controller: c } = controller();

        await c.getIssuanceConfigurations(token([Role.IssuanceRead]));

        expect(service.getIssuanceConfigurationOrDefault).toHaveBeenCalledWith(
            "t1",
            { store: false },
        );
    });

    it("stores the default for issuance:manage", async () => {
        const { service, controller: c } = controller();

        await c.getIssuanceConfigurations(
            token([Role.Issuances, Role.IssuanceOffer, Role.IssuanceRead]),
        );

        expect(service.getIssuanceConfigurationOrDefault).toHaveBeenCalledWith(
            "t1",
            { store: true },
        );
    });
});
