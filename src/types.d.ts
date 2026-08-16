import type { User } from './store.js';
import type { AuthClaims } from './security.js';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthClaims;
      user?: User;
      rawBody?: Buffer;
      requestId?: string;
    }
  }
}

export {};
