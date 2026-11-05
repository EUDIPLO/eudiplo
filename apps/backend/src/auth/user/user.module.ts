import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { readAuthSettings } from "../auth-settings.js";
import { IdpManagedUsersProvider } from "./adapters/idp-managed-users.service.js";
import { InternalUsersProvider } from "./adapters/internal-users.service.js";
import { KeycloakUsersProvider } from "./adapters/keycloak-users.service.js";
import { UserController } from "./user.controller.js";
import { USERS_PROVIDER, UsersProvider } from "./user.provider.js";

@Module({
    providers: [
        {
            provide: USERS_PROVIDER,
            inject: [ConfigService],
            useFactory: (configService: ConfigService): UsersProvider => {
                const { mode } = readAuthSettings(configService);
                if (mode === "keycloak") {
                    return new KeycloakUsersProvider(configService);
                }
                return mode === "generic"
                    ? new IdpManagedUsersProvider()
                    : new InternalUsersProvider();
            },
        },
    ],
    exports: [USERS_PROVIDER],
    controllers: [UserController],
})
export class UserModule {}
