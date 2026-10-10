import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { config } from '../config.js';
export const auth = betterAuth({
  secret: config.AUTH_SECRET, baseURL: config.APP_URL, basePath: '/api/auth', trustedOrigins: [config.APP_URL],
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 10, maxPasswordLength: 128 },
  user: { additionalFields: { isAdmin: { type: 'boolean', defaultValue: false, input: false }, disabled: { type: 'boolean', defaultValue: false, input: false } } },
  session: { expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
  advanced: { useSecureCookies: config.NODE_ENV === 'production' },
  rateLimit: { enabled: true, window: 60, max: 30 },
});
