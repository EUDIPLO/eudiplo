import { Module, type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AUTH_SETTINGS, type AuthSettings } from "../auth-settings.js";
import { AuthSettingsModule } from "../auth-settings.module.js";
import { KeycloakUsersProvider } from "./adapters/keycloak-users.service.js";
import { UnmanagedUsersProvider } from "./adapters/unmanaged-users.service.js";
import { UserController } from "./user.controller.js";
import { USERS_PROVIDER, UsersProvider } from "./user.provider.js";

/** The users adapter of the authentication mode; only Keycloak manages people. */
export const usersProvider: Provider = {
    provide: USERS_PROVIDER,
    inject: [AUTH_SETTINGS, ConfigService],
    useFactory: (
        settings: AuthSettings,
        configService: ConfigService,
    ): UsersProvider =>
        settings.mode === "keycloak"
            ? new KeycloakUsersProvider(configService)
            : new UnmanagedUsersProvider(settings.mode),
};

@Module({
    imports: [AuthSettingsModule],
    providers: [usersProvider],
    exports: [USERS_PROVIDER],
    controllers: [UserController],
})
export class UserModule {}
