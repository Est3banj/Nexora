import type { FastifyInstance, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_RE,
  PASSWORD_MIN,
  memberEmailFromUsername,
} from "@pos/shared";
import { getAuth } from "../auth/auth";
import { repoFor } from "../auth/ctx";
import { setUserPassword } from "../auth/password";
import { config } from "../config";

const roleSchema = z.enum(["member", "admin"]);
const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // Members are identified by username + password (never by email). The
  // synthetic email the SDK still requires is derived server-side.
  username: z.string().trim()
    .min(USERNAME_MIN_LENGTH).max(USERNAME_MAX_LENGTH)
    .regex(USERNAME_RE, "username_invalid"),
  password: z.string().min(PASSWORD_MIN).max(128),
  role: roleSchema,
}).strict();
const resetSchema = z.object({
  newPassword: z.string()
    .min(PASSWORD_MIN, `La contraseña debe tener al menos ${PASSWORD_MIN} caracteres.`)
    .max(128),
}).strict();
const memberParams = z.object({ memberId: z.string().uuid() });
const safeMember = (m: { id: string; userId: string; role: string; createdAt: Date }) => ({
  id: m.id, userId: m.userId, role: m.role, createdAt: m.createdAt,
});

/**
 * better-auth surfaces sign-up failures in two different shapes: a non-ok
 * `Response` (email duplicate → 422 USER_ALREADY_EXISTS…) or a THROWN APIError
 * (the username plugin's uniqueness middleware → 400 "Username is already
 * taken…"). Both end up here so the BFF answers with one honest, stable code.
 */
function signupFailure(reply: FastifyReply, status: number, detail: string) {
  const usernameTaken = /username is already taken|USERNAME_IS_ALREADY_TAKEN/i.test(detail);
  const taken = usernameTaken || status === 409 || /already|exists|taken/i.test(detail);
  return reply.code(taken ? 409 : 400).send({
    error: usernameTaken ? "username_taken" : taken ? "email_taken" : "user_create_failed",
  });
}

export async function adminUsersRoutes(app: FastifyInstance): Promise<void> {
  const preHandler = [app.requireAuth, app.requireDueño];
  // P2-7 · this router mints credentials and revokes access: 30 req/min/IP,
  // the same per-route `config.rateLimit` shape app.ts uses for /api/auth/*.
  // Disabled in tests (NODE_ENV=test) exactly like the global/auth windows,
  // otherwise the suites would throttle themselves.
  const rateLimited = config.nodeEnv !== "test"
    ? { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }
    : {};
  app.get("/api/admin/members", { preHandler, ...rateLimited }, async (req, reply) => {
    const { members } = await getAuth().api.listMembers({
      query: { organizationId: req.ctx.tenantId!, limit: 10000 }, headers: fromNodeHeaders(req.headers),
    });
    // See db/scope.ts → authMembers.usernames: the SDK's member projection
    // drops `username`, so it is fetched in one extra query.
    const usernames = await repoFor(req).authMembers.usernames(members.map(m => m.userId));
    // PII (name/e-mail/username per member) → never cacheable.
    reply.header("Cache-Control", "no-store");
    return { members: members.map(m => ({
      ...safeMember(m),
      user: {
        id: m.user.id, name: m.user.name, email: m.user.email,
        username: usernames.get(m.userId) ?? null,
      },
    })) };
  });

  app.post("/api/admin/users", { preHandler, ...rateLimited }, async (req, reply) => {
    const input = createSchema.parse(req.body);
    if (req.ctx.role !== "owner" && input.role !== "member") return reply.code(403).send({ error: "owner_only" });
    const auth = getAuth();
    // better-auth's base user schema still requires a unique email, and this
    // app sends no mail at all — so members get a synthetic address derived
    // from the username (packages/shared/src/username.ts). Their real
    // credential is `username` + password; they never sign in with this.
    const email = memberEmailFromUsername(input.username);
    // Built as a variable on purpose: better-auth types the sign-up body as
    // `z.object({...}).and(z.record(...))`, and TS collapses that intersection
    // to `{}`, so a fresh literal with the extra `username` key is rejected
    // even though the SDK forwards it at runtime (that is exactly how the
    // username plugin receives it on /sign-up/email).
    const signUpBody = { name: input.name, email, password: input.password, username: input.username };
    // A signup creates a new session. NEVER copy its cookies/token to the manager's response.
    let signup: Response;
    try {
      signup = await auth.api.signUpEmail({ body: signUpBody, asResponse: true });
    } catch (err) {
      // The username plugin throws its uniqueness error instead of returning
      // a Response — map it exactly like a non-ok response.
      const e = err as { statusCode?: number; message?: string; body?: unknown };
      return signupFailure(reply, e.statusCode ?? 500, `${e.message ?? ""} ${JSON.stringify(e.body ?? {})}`);
    }
    if (!signup.ok) return signupFailure(reply, signup.status, await signup.text());
    const { user } = await signup.json() as { user: { id: string; name: string; email: string; username?: string | null } };
    const repo = repoFor(req);
    let member;
    try {
      member = await auth.api.addMember({
        body: { organizationId: req.ctx.tenantId!, userId: user.id, role: input.role },
        headers: fromNodeHeaders(req.headers),
      });
    } catch {
      // No orphaned-success response; remove the new account when no membership exists.
      const removed = await repo.authMembers.discardUnassignedUser(user.id).catch(() => false);
      return reply.code(removed ? 409 : 500).send({ error: "membership_create_failed", account_created: !removed });
    }
    await repo.auditLog.insert({ actor: req.ctx.userId, action: "member.create", meta: {
      member_id: member.id, user_id: user.id, role: member.role, username: input.username,
    } });
    reply.header("Cache-Control", "no-store");
    return reply.code(201).send({
      user: { id: user.id, name: user.name, email: user.email, username: user.username ?? input.username },
      member: safeMember(member),
    });
  });

  app.patch("/api/admin/members/:memberId", { preHandler, ...rateLimited }, async (req, reply) => {
    const { memberId } = memberParams.parse(req.params);
    const { role } = z.object({ role: roleSchema }).strict().parse(req.body);
    const repo = repoFor(req);
    const target = await repo.authMembers.byId(memberId);
    if (!target) return reply.code(404).send({ error: "not_found" });
    if (target.role.split(",").includes("owner")) return reply.code(403).send({ error: "owner_readonly" });
    if (req.ctx.role !== "owner" && (target.role !== "member" || role !== "member")) return reply.code(403).send({ error: "owner_only" });
    const member = await getAuth().api.updateMemberRole({
      body: { memberId, role, organizationId: req.ctx.tenantId! }, headers: fromNodeHeaders(req.headers),
    });
    await repo.auditLog.insert({ actor: req.ctx.userId, action: "member.role_change", meta: {
      member_id: memberId, previous_role: target.role, role,
    } });
    return { member: safeMember(member) };
  });

  /**
   * A2 · restablecer la contraseña de un empleado (perdió el acceso).
   *
   * Deliberately NOT the better-auth admin plugin: its `role` column is
   * GLOBAL, while this app's roles live on `member` per tenant — the two
   * collide (audited and rejected with evidence). Everything below runs on
   * the tenant-scoped repo + the auth context instead.
   */
  app.post("/api/admin/members/:memberId/password", { preHandler, ...rateLimited }, async (req, reply) => {
    const { memberId } = memberParams.parse(req.params);
    const { newPassword } = resetSchema.parse(req.body);
    const repo = repoFor(req);
    // Scoped by organizationId → a foreign memberId is a 404, never a 403
    // (no tenant-existence oracle, no IDOR).
    const target = await repo.authMembers.byId(memberId);
    if (!target) return reply.code(404).send({ error: "not_found" });
    if (target.userId === req.ctx.userId) return reply.code(403).send({ error: "cannot_reset_self" });
    // Same owner_readonly rule as PATCH/DELETE: an `admin` must not be able
    // to take over the owner's account by resetting its password.
    if (target.role.split(",").includes("owner")) return reply.code(403).send({ error: "owner_readonly" });
    // updatePassword is a silent no-op without a credential account — the
    // helper branches exactly like better-auth's own setUserPassword.
    await setUserPassword(target.userId, newPassword);
    // A rotated credential must not leave the old sessions alive.
    const ctx = await getAuth().$context;
    await ctx.internalAdapter.deleteUserSessions(target.userId);
    // NEVER the password (nor its hash) — ids only.
    await repo.auditLog.insert({ actor: req.ctx.userId, action: "member.password_reset", meta: {
      member_id: memberId, user_id: target.userId,
    } });
    reply.header("Cache-Control", "no-store");
    return reply.code(200).send({ ok: true });
  });

  app.delete("/api/admin/members/:memberId", { preHandler, ...rateLimited }, async (req, reply) => {
    const { memberId } = memberParams.parse(req.params);
    const repo = repoFor(req);
    const target = await repo.authMembers.byId(memberId);
    if (!target) return reply.code(404).send({ error: "not_found" });
    if (target.role.split(",").includes("owner")) return reply.code(403).send({ error: "owner_readonly" });
    if (req.ctx.role !== "owner" && target.role !== "member") return reply.code(403).send({ error: "owner_only" });
    await getAuth().api.removeMember({
      body: { memberIdOrEmail: memberId, organizationId: req.ctx.tenantId! }, headers: fromNodeHeaders(req.headers),
    });
    await repo.auditLog.insert({ actor: req.ctx.userId, action: "member.remove", meta: {
      member_id: memberId, user_id: target.userId, role: target.role,
    } });
    return { ok: true };
  });
}
