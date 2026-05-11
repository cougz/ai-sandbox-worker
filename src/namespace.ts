// ─── Workspace namespace helpers ──────────────────────────────────────────────
// Pulled out into its own module so utility modules (view-protect.ts, agent.ts)
// can import without pulling in the much larger access-handler.ts.

/** Fixed namespace for the team shared workspace — readable and writable by all users. */
export const SHARED_NAMESPACE = "team_shared";

/**
 * Derives a valid Workspace namespace string from an email address.
 * Both agent.ts and access-handler.ts must use this same function or D1
 * lookups will mis-target.
 */
export function emailToNamespace(email: string): string {
  return "u_" + email.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_").replace(/_$/, "").slice(0, 60);
}
