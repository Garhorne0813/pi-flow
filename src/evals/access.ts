import { JUDGE_TEMPLATE, JUDGE_TEMPLATE_VERSION } from "./judge-template.js";
import { AgentConfig } from "../domain/model.js";
import { agentAllowed, Fault, type Actor } from "../domain/model.js";
import type { PersonalService } from "../domain/personal-service.js";
import { policyFromEnv } from "../domain/usage.js";
import { digest } from "./dataset.js";
import type { EvalJob, EvalSnapshot } from "./jobs.js";
import { openToken } from "../security/token-vault.js";
export class EvalAccess {
  constructor(
    private service: PersonalService,
    private demo = false,
  ) {}
  async snapshot(a: Actor, agentId: string): Promise<EvalSnapshot> {
    await this.service.verifyActor(a);
    return this.service.registry.read((s) => {
      const agent = s.managedAgents?.[agentId];
      if (!agent || !agentAllowed(agent, a))
        throw new Fault(404, "AGENT_NOT_FOUND");
      const entry = s.modelCatalog?.find(
        (m) =>
          m.provider === agent.config.model.provider &&
          m.modelId === agent.config.model.modelId,
      );
      if (!this.demo && !entry?.gatewayRef)
        throw new Fault(403, "EVAL_APPROVED_MODEL_REQUIRED");
      const prices = policyFromEnv().prices;
      if (this.demo)
        prices[agent.config.model.provider + "/" + agent.config.model.modelId] =
          { version: "demo", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let judge: EvalSnapshot["judge"];
      if (process.env.EVAL_JUDGE_ENABLED === "true") {
        const selection = process.env.EVAL_JUDGE_MODEL;
        const selected = s.modelCatalog?.find(
          (m) => m.provider + "/" + m.modelId === selection,
        );
        if (!selected?.gatewayRef)
          throw new Fault(503, "EVAL_JUDGE_MODEL_NOT_APPROVED");
        const config = AgentConfig.parse({
          name: "eval-judge",
          systemPrompt: JUDGE_TEMPLATE,
          model: { provider: selected.provider, modelId: selected.modelId },
          tools: [],
          maxTokens: 16000,
          maxSteps: 1,
        });
        judge = {
          config,
          gatewayRef: selected.gatewayRef,
          version: digest({
            template: JUDGE_TEMPLATE_VERSION,
            model: config.model,
            gateway: selected.gatewayRef,
            temperature: 0,
          }),
        };
      }
      return {
        judge,
        config: structuredClone(agent.config),
        gatewayRef: entry?.gatewayRef ?? null,
        skillDigests: Object.fromEntries(
          agent.config.skills.map((k) => [
            k,
            s.skills[k]?.versionDigest ?? s.skills[k]?.digest ?? "unavailable",
          ]),
        ),
        bundleDigest: digest({
          bundle: agent.config.skillBundle,
          skills: agent.config.skills,
        }),
        graderVersion: "1",
        profile: "mocked",
        prices,
      };
    });
  }
  async authorize(job: EvalJob, tool?: string) {
    await this.service.verifyActor(job.actor);
    await this.service.registry.read((s) => {
      const agent = s.managedAgents?.[job.request.agentId];
      if (!agent || !agentAllowed(agent, job.actor))
        throw new Fault(403, "EVAL_ACCESS_REVOKED");
      if (
        tool &&
        (!agent.config.tools.includes(tool as never) ||
          s.policy?.disabledTools.includes(tool))
      )
        throw new Fault(403, "EVAL_TOOL_REVOKED");
      for (const selected of [job.snapshot, job.snapshot.judge].filter(
        (x) => x !== undefined,
      )) {
        if (
          !this.demo &&
          !s.modelCatalog?.some(
            (m) =>
              m.provider === selected.config.model.provider &&
              m.modelId === selected.config.model.modelId,
          )
        )
          throw new Fault(403, "MODEL_NOT_APPROVED");
      }
    });
  }
  async gateway(snapshot: Pick<EvalSnapshot, "gatewayRef">) {
    if (this.demo && !snapshot.gatewayRef) return undefined;
    return this.service.registry.read((s) => {
      const g = s.modelGatewayVersions?.[snapshot.gatewayRef ?? ""],
        secret = g && s.modelSecretVersions?.[g.secretVersion];
      if (!g || !secret) throw new Fault(503, "MODEL_SNAPSHOT_UNAVAILABLE");
      return {
        baseUrl: g.baseUrl,
        apiKey: openToken(
          secret.sealed,
          "platform:" + secret.ref,
          "CONFIG_SECRET_KEY",
        ),
      };
    });
  }
}
