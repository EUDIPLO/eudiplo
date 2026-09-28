export class InvalidCredentialProof extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidCredentialProof";
    }
}
