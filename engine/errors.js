// Every error PitchPlease reports carries a stable `code` so apps can branch on it; `message` says what to do.
export class PitchPleaseError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'PitchPleaseError';
    this.code = code;
  }
}
