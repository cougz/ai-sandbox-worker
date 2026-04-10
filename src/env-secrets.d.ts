// Runtime secrets — set via `wrangler secret put`.
// These are not included in auto-generated worker-configuration.d.ts
// because wrangler only generates types for bindings declared in wrangler.jsonc.
interface Env {
  ADMIN_EMAILS: string;
  ADMIN_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
  ACCESS_TOKEN_URL: string;
  ACCESS_AUTHORIZATION_URL: string;
  ACCESS_JWKS_URL: string;
}
