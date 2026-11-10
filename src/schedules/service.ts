import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import {
  Fault,
  id,
  terminal,
  audit,
  type Actor,
  type State,
  agentAllowed,
} from "../domain.js";
import { createRun } from "../service.js";
import type { PersonalService } from "../personal-service.js";
import { workspacePath } from "../security-path.js";
export const ScheduleInput = z
  .object({
    agentId: z.string().min(1),
    cron: z.string().max(200),
    timezone: z.string().default("UTC"),
    prompt: z.string().min(1).max(32000),
    cwd: z.string().default("/workspace"),
    sessionMode: z.enum(["reuse", "new"]).default("reuse"),
    approvalMode: z.enum(["deny", "guarded", "auto"]).default("deny"),
    allowedTools: z.array(z.string()).optional(),
    enabled: z.boolean().default(true),
    maxConsecutiveFailures: z.number().int().min(1).max(100).default(3),
  })
  .strict();
export type ScheduledTask = z.infer<typeof ScheduleInput> & {
  id: string;
  userId: string;
  actor: Actor;
  nextFireAt: number;
  sessionId?: string;
  failures: number;
  createdAt: string;
};
export type Fire = {
  id: string;
  scheduleId: string;
  scheduledFor: number;
  trigger: "cron" | "manual";
  runId?: string;
  state: "submitted" | "skipped" | "completed" | "failed";
  error?: string;
};
export function nextFire(cron: string, timezone: string, now = Date.now()) {
  if (cron.trim().split(/\s+/).length !== 5)
    throw new Fault(400, "INVALID_CRON");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    return CronExpressionParser.parse(cron, { tz: timezone, currentDate: now })
      .next()
      .getTime();
  } catch {
    throw new Fault(400, "INVALID_CRON_OR_TIMEZONE");
  }
}
export class ScheduleService {
  constructor(private service: PersonalService) {}
  async create(a: Actor, input: unknown) {
    const b = ScheduleInput.parse(input),
      cwd = workspacePath(b.cwd),
      nextFireAt = nextFire(b.cron, b.timezone);
    await this.service.ensureWorkspace(a);
    return this.service.store.tx(a.tenantId, (s) => {
      const av = s.managedAgents?.[b.agentId];
      if (!av || !agentAllowed(av, a)) throw new Fault(404, "AGENT_NOT_FOUND");
      if (av.config.userTokenAccess)
        throw new Fault(400, "SCHEDULE_USER_TOKEN_UNSUPPORTED");
      const task: ScheduledTask = {
        ...b,
        cwd,
        id: id(),
        userId: a.userId,
        actor: { ...a, expiresAt: undefined },
        nextFireAt,
        failures: 0,
        createdAt: new Date().toISOString(),
      };
      (s.schedules ??= {})[task.id] = task;
      audit(s, a, "schedule.create", task.id);
      return task;
    });
  }
  async update(a: Actor, sid: string, input: unknown) {
    return this.service.store.tx(a.tenantId, (s) => {
      const task = this.get(s, a, sid);
      const b = ScheduleInput.parse({
        ...taskFields(task),
        ...z.record(z.string(), z.unknown()).parse(input),
      });
      const av = s.managedAgents?.[b.agentId];
      if (!av || !agentAllowed(av, a)) throw new Fault(404, "AGENT_NOT_FOUND");
      if (av.config.userTokenAccess)
        throw new Fault(400, "SCHEDULE_USER_TOKEN_UNSUPPORTED");
      const cwd = workspacePath(b.cwd);
      if (
        b.agentId !== task.agentId ||
        cwd !== task.cwd ||
        b.sessionMode !== task.sessionMode
      )
        delete task.sessionId;
      Object.assign(task, b, {
        cwd,
        nextFireAt: nextFire(b.cron, b.timezone),
      });
      audit(s, a, "schedule.update", sid);
      return task;
    });
  }
  get(s: State, a: Actor, sid: string) {
    const task = s.schedules?.[sid];
    if (!task || task.userId !== a.userId)
      throw new Fault(404, "SCHEDULE_NOT_FOUND");
    return task;
  }
  fire(
    s: State,
    task: ScheduledTask,
    now: number,
    trigger: "cron" | "manual",
  ): Fire {
    const scheduledFor = trigger === "cron" ? task.nextFireAt : now,
      key = `${task.id}:${trigger}:${scheduledFor}`;
    if (s.scheduleFires?.[key]) {
      if (trigger === "cron")
        task.nextFireAt = nextFire(task.cron, task.timezone, now);
      return s.scheduleFires[key]!;
    }
    const fire: Fire = {
      id: id(),
      scheduleId: task.id,
      scheduledFor,
      trigger,
      state: "submitted",
    };
    (s.scheduleFires ??= {})[key] = fire;
    if (trigger === "cron")
      task.nextFireAt = nextFire(task.cron, task.timezone, now);
    const a = task.actor,
      av = s.managedAgents?.[task.agentId];
    if (!av || !agentAllowed(av, a) || av.config.userTokenAccess) {
      this.settle(task, fire, "failed", "SCHEDULE_AGENT_UNAVAILABLE");
      audit(s, a, "schedule.fire", fire.id, fire.state);
      return fire;
    }
    if (
      !task.sessionId ||
      task.sessionMode === "new" ||
      !s.sessions[task.sessionId] ||
      s.sessions[task.sessionId]?.deletedAt ||
      s.sessions[task.sessionId]?.agentId !== task.agentId ||
      s.sessions[task.sessionId]?.cwd !== task.cwd
    ) {
      const sid = id();
      s.sessions[sid] = {
        id: sid,
        userId: a.userId,
        workspaceId: a.userId,
        agentId: av.id,
        cwd: task.cwd,
        entries: [],
        createdAt: new Date(now).toISOString(),
      };
      task.sessionId = sid;
    }
    try {
      const r = createRun(
        s,
        a,
        task.sessionId,
        task.prompt,
        `schedule:${fire.id}`,
        {
          schedule: {
            id: task.id,
            fireId: fire.id,
            approvalMode: task.approvalMode,
            allowedTools: task.allowedTools,
          },
        },
      );
      fire.runId = r.id;
    } catch (e) {
      if (!(e instanceof Fault)) throw e;
      this.settle(
        task,
        fire,
        e.code === "SESSION_BUSY" ? "skipped" : "failed",
        e.code,
      );
    }
    audit(s, a, "schedule.fire", fire.id, fire.state);
    return fire;
  }
  async manual(a: Actor, sid: string) {
    return this.service.store.tx(a.tenantId, (s) =>
      this.fire(s, this.get(s, a, sid), Date.now(), "manual"),
    );
  }
  async tick() {
    if (this.service.store.listScheduleWork && this.service.store.scheduleTx) {
      for (const {
        user,
        scheduleId,
      } of await this.service.store.listScheduleWork(Date.now(), 64))
        await this.service.store.scheduleTx(user, scheduleId, (s) =>
          this.settleAndFire(s, Date.now()),
        );
      return;
    }
    for (const user of await this.service.store.tenants())
      await this.service.store.tx(user, (s) =>
        this.settleAndFire(s, Date.now()),
      );
  }
  private settle(
    task: ScheduledTask | undefined,
    fire: Fire,
    state: "completed" | "failed" | "skipped",
    error?: string,
  ) {
    if (fire.state !== "submitted") return;
    fire.state = state;
    fire.error = error;
    // Busy-session skips neither increment nor reset consecutive failures.
    if (!task || state === "skipped") return;
    task.failures = state === "failed" ? task.failures + 1 : 0;
    if (task.failures >= task.maxConsecutiveFailures) task.enabled = false;
  }
  private settleAndFire(s: State, now: number) {
    for (const fire of Object.values(s.scheduleFires ?? {})) {
      if (fire.state !== "submitted" || !fire.runId) continue;
      const run = s.runs[fire.runId],
        task = s.schedules?.[fire.scheduleId];
      if (!run || !terminal(run.state)) continue;
      this.settle(
        task,
        fire,
        run.state === "COMPLETED" ? "completed" : "failed",
        run.error,
      );
    }
    for (const task of Object.values(s.schedules ?? {}))
      if (task.enabled && task.nextFireAt <= now)
        this.fire(s, task, now, "cron");
  }
}
function taskFields(t: ScheduledTask) {
  const {
    id,
    userId,
    actor,
    nextFireAt,
    sessionId,
    failures,
    createdAt,
    ...fields
  } = t;
  return fields;
}
