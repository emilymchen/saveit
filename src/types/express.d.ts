declare global {
  namespace Express {
    interface Request {
      /**
       * Exact bytes of the request body, captured by the JSON parser's `verify`
       * hook. Required for Meta's HMAC signature check — the parsed object
       * cannot be re-serialized back into the same bytes.
       */
      rawBody?: Buffer;
    }
  }
}

export {};
