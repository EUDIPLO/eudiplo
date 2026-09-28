import { SessionCleanupMode } from "./domain/session-retention.js";

export const SESSION_SETTINGS = Symbol("SESSION_SETTINGS");

export interface SessionSettings {
    defaultTtlSeconds: number;
    defaultCleanupMode: SessionCleanupMode;
}
