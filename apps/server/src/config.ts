import 'dotenv/config';
import { z } from 'zod';
const env = z.object({
  NODE_ENV: z.enum(['development','production','test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(18420),
  APP_URL: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1), AUTH_SECRET: z.string().min(32),
  SETUP_TOKEN: z.string().min(24),
  UPLOAD_DIR: z.string().default('.data/uploads'), WEB_DIST: z.string().default('apps/web/dist'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(104857600).default(20971520),
  SMTP_HOST: z.string().optional(), SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(), SMTP_PASS: z.string().optional(), SMTP_FROM: z.string().optional(),
}).parse(process.env);
export const config = env;
