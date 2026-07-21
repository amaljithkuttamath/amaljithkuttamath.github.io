// abort.ts — the user-cancel sentinel. Thrown at ask()'s boundary checks (and
// by the session-less dashboard refresh pipeline) to unwind promptly on a stop.
// A user-cancel is NOT a failure, so this is deliberately its own error type,
// never a provider ClassifiedError. Shared so the loop and the refresh pipeline
// throw/catch the same class.
// Thrown internally by ask()'s boundary checks the instant the caller's stop
// signal is seen, to unwind the tool loop (and any sub-agent loop) promptly. It
// never escapes ask(): the top-level handler catches it — and any error raised
// while the signal is already aborted — and converts it to the aborted output.
// Deliberately NOT a provider ClassifiedError: a user-cancel is not a failure.
export class AbortedError extends Error {
  constructor() {
    super('aborted by user');
    this.name = 'AbortedError';
  }
}
