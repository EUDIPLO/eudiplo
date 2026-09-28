import { NotFoundError } from "../../shared/domain/not-found-error.js";

export class SessionNotFound extends NotFoundError {
    constructor() {
        super("Session not found");
        this.name = "SessionNotFound";
    }
}
