// Errors that carry what the API needs to answer: an HTTP status, a stable code and a readable message.
export class AppError extends Error {
  /**
   * @param {number} status HTTP status of the answer
   * @param {string} code stable, machine-readable identifier the UI can translate
   * @param {string} message readable English text for logs and API clients
   */
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code, message, details) => new AppError(400, code, message, details);
export const notFound = (what) => new AppError(404, 'not_found', `${what} was not found`);
export const conflict = (code, message) => new AppError(409, code, message);
