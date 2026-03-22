export class GatewayError extends Error {
    retryable;
    constructor(message, retryable) {
        super(message);
        this.retryable = retryable;
        this.name = "GatewayError";
    }
}
//# sourceMappingURL=types.js.map