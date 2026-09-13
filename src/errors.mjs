export class GatewayError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function asGatewayError(error) {
  if (error instanceof GatewayError) return error;
  return new GatewayError("INTERNAL_ERROR", String(error?.message ?? error), 500);
}
