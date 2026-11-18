import { getAuth } from "./auth";

/**
 * Write a user's credential password, byte-for-byte the branch better-auth
 * uses in its own `setUserPassword`
 * (`better-auth/dist/plugins/admin/routes.mjs:815`).
 *
 * WHY THE BRANCH MATTERS: `internalAdapter.updatePassword(userId, hash)`
 * UPDATEs the row returned by `findCredentialAccount` — with no credential
 * account it matches nothing and returns normally. The password silently
 * stays whatever it was, the caller gets `Promise<void>` and reports success.
 * Creating the account in the else-arm is the only way a user without a
 * `providerId: "credential"` row can ever start signing in.
 *
 * Used by:
 *  · POST /api/admin/members/:memberId/password (admin reset)
 *  · pnpm seed (keeps the demo owner idempotent when SEED_OWNER_PASSWORD changes)
 *
 * Sessions are NOT touched here: callers decide (a reset must kill the old
 * sessions, a seed wants the same).
 */
export async function setUserPassword(
  userId: string,
  newPassword: string,
): Promise<void> {
  const ctx = await getAuth().$context;
  const hash = await ctx.password.hash(newPassword);
  if (await ctx.internalAdapter.findCredentialAccount(userId)) {
    await ctx.internalAdapter.updatePassword(userId, hash);
  } else {
    await ctx.internalAdapter.createAccount({
      userId,
      providerId: "credential",
      accountId: userId,
      password: hash,
    });
  }
}
