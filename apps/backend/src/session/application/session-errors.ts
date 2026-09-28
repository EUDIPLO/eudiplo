export class SessionNotFound extends Error {
    constructor() {
        super("Session not found");
        this.name = "SessionNotFound";
    }
}
