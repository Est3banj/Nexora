import type { FastifyInstance, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_RE,
  memberEmailFromUsername,
} from "@pos/shared";
import { getAuth } from "../auth/auth";
import { repoFor } from "../auth/ctx";

const roleSchema = z.enum(["member", "admin"]);
const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // Members are identified by username + password (never by email). The
  // synthetic email the SDK still requires is derived server-side.
  username: z.string().trim()
    .min(USERNAME_MIN_LENGTH).max(USERNAME_MAX_LENGTH)
    .regex(USERNAME_RE, "username_invalid"),
  password: z.string().min(12).max(128),
  role: roleSchema,
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
  app.get("/api/admin/members", { preHandler }, async req => {
    const { members } = await getAuth().api.listMembers({
      query: { organizationId: req.ctx.tenantId!, limit: 10000 }, headers: fromNodeHeaders(req.headers),
    });
    // See db/scope.ts → authMembers.usernames: the SDK's member projection
    // drops `username`, so it is fetched in one extra query.
    const usernames = await repoFor(req).authMembers.usernames(members.map(m => m.userId));
    return { members: members.map(m => ({
      ...safeMember(m),
      user: {
        id: m.user.id, name: m.user.name, email: m.user.email,
        username: usernames.get(m.userId) ?? null,
      },
    })) };
  });

  app.post("/api/admin/users", { preHandler }, async (req, reply) => {
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

  app.patch("/api/admin/members/:memberId", { preHandler }, async (req, reply) => {
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

  app.delete("/api/admin/members/:memberId", { preHandler }, async (req, reply) => {
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
