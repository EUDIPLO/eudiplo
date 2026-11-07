import { Module, type Provider } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { AUTH_SETTINGS, readAuthSettings } from "./auth-settings.js";

/** The authentication settings, read once for every module that needs them. */
export const authSettingsProvider: Provider = {
    provide: AUTH_SETTINGS,
    inject: [ConfigService],
    useFactory: readAuthSettings,
};

@Module({
    imports: [ConfigModule],
    providers: [authSettingsProvider],
    exports: [AUTH_SETTINGS],
})
export class AuthSettingsModule {}
