import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { getAuth } from "../auth/auth";
import { repoFor } from "../auth/ctx";

const roleSchema = z.enum(["member", "admin"]);
const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().email().max(254),
  password: z.string().min(12).max(128).optional(),
  role: roleSchema,
}).strict();
const memberParams = z.object({ memberId: z.string().uuid() });
const safeMember = (m: { id: string; userId: string; role: string; createdAt: Date }) => ({
  id: m.id, userId: m.userId, role: m.role, createdAt: m.createdAt,
});

export async function adminUsersRoutes(app: FastifyInstance): Promise<void> {
  const preHandler = [app.requireAuth, app.requireDueño];
  app.get("/api/admin/members", { preHandler }, async req => {
    const { members } = await getAuth().api.listMembers({
      query: { organizationId: req.ctx.tenantId!, limit: 10000 }, headers: fromNodeHeaders(req.headers),
    });
    return { members: members.map(m => ({ ...safeMember(m), user: {
      id: m.user.id, name: m.user.name, email: m.user.email,
    } })) };
  });

  app.post("/api/admin/users", { preHandler }, async (req, reply) => {
    const input = createSchema.parse(req.body);
    if (req.ctx.role !== "owner" && input.role !== "member") return reply.code(403).send({ error: "owner_only" });
    const password = input.password ?? randomBytes(18).toString("base64url");
    const auth = getAuth();
    // A signup creates a new session. NEVER copy its cookies/token to the manager's response.
    const signup = await auth.api.signUpEmail({
      body: { name: input.name, email: input.email, password }, asResponse: true,
    });
    if (!signup.ok) {
      const detail = await signup.text();
      const taken = signup.status === 409 || /already|exists|taken/i.test(detail);
      return reply.code(taken ? 409 : 400).send({ error: taken ? "email_taken" : "user_create_failed" });
    }
    const { user } = await signup.json() as { user: { id: string; name: string; email: string } };
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
      member_id: member.id, user_id: user.id, role: member.role,
    } });
    reply.header("Cache-Control", "no-store");
    return reply.code(201).send({ user: { id: user.id, name: user.name, email: user.email },
      member: safeMember(member), ...(input.password === undefined ? { generated_password: password } : {}) });
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
