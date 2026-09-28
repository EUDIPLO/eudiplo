export class InvalidCredentialOffer extends Error {
    constructor() {
        super("Invalid credential configuration ID");
        this.name = "InvalidCredentialOffer";
    }
}
