import {
    WorkflowEntrypoint,
    WorkflowEvent,
    WorkflowStep,
  } from "cloudflare:workers";
  import { NonRetryableError } from "cloudflare:workflows";
  import type { Env, ProjectConfig, TranslateWorkflowParams } from "../types";
  import { LokaliseClient } from "../lokalise-client";
  
  const TERMINAL_OK = new Set(["completed", "closed"]);
  const TERMINAL_BAD = new Set(["failed", "cancelled", "canceled"]);
  
  type RunRow = {
    status: string;
    lokalise_task_id: number | null;
  };
  
  export class TranslateAiWorkflow extends WorkflowEntrypoint<
    Env,
    TranslateWorkflowParams
  > {
    async run(
      event: WorkflowEvent<TranslateWorkflowParams>,
      step: WorkflowStep,
    ) {
      const { runId, projectId, branch, keyIds } = event.payload;
  
      const config = await step.do("load-config", async () => {
        const raw = await this.env.CONFIG.get(`project:${projectId}`);
        if (!raw) {
          throw new NonRetryableError(`Missing KV config project:${projectId}`);
        }
        const cfg = JSON.parse(raw) as ProjectConfig;
        if (!cfg.enabled) throw new NonRetryableError("Project disabled in KV");
        if (!cfg.target_langs?.length) {
          throw new NonRetryableError("target_langs empty in KV config");
        }
        return cfg;
      });
  
      const existing = await step.do("check-existing-task", async () => {
        return this.env.DB.prepare(
          `SELECT status, lokalise_task_id FROM runs WHERE id = ?`,
        )
          .bind(runId)
          .first<RunRow>();
      });
  
      // Already finished — nothing left to do
      if (existing?.status === "completed") {
        console.log(
          JSON.stringify({ msg: "check-existing-task:already-completed", runId, existing }),
        );
        return;
      }
  
      // Already failed — don't create another task
      if (existing?.status === "failed") {
        console.log(
          JSON.stringify({ msg: "check-existing-task:already-failed", runId, existing }),
        );
        throw new NonRetryableError(
          existing.error
            ? `Run already failed: ${existing.error}`
            : "Run already failed",
        );
      }
  
      const alreadyCreated =
        !!existing?.lokalise_task_id || existing?.status === "waiting";
  
      if (alreadyCreated) {
        console.log(
          JSON.stringify({ msg: "check-existing-task:skip-create", runId, existing }),
        );
      } else {
        console.log(
          JSON.stringify({ msg: "check-existing-task:will-create", runId, existing }),
        );
  
        await step.do("mark-task-creating", async () => {
          const now = new Date().toISOString();
          await this.env.DB.prepare(
            `UPDATE runs SET status = ?, updated_at = ? WHERE id = ?`,
          )
            .bind("task_creating", now, runId)
            .run();
        });
      }
  
      const task = alreadyCreated
        ? { task_id: existing!.lokalise_task_id! }
        : await step.do("create-ai-task", async () => {
            console.log(
              JSON.stringify({
                msg: "create-ai-task:request",
                runId,
                projectId,
                branch,
                sourceLang: config.source_lang,
                targetLangs: config.target_langs,
                keyCount: keyIds.length,
                keyIds,
              }),
            );
  
            const client = new LokaliseClient(this.env.LOKALISE_API_TOKEN);
            const created = await client.createAutomaticTranslationTask({
              projectId,
              title: `AI ${branch ?? "upload"} ${runId.slice(0, 8)}`,
              sourceLang: config.source_lang,
              targetLangs: config.target_langs,
              keyIds,
            });
  
            console.log(
              JSON.stringify({
                msg: "create-ai-task:result",
                runId,
                task: created,
              }),
            );
  
            const now = new Date().toISOString();
            await this.env.DB.prepare(
              `UPDATE runs SET lokalise_task_id = ?, status = ?, updated_at = ? WHERE id = ?`,
            )
              .bind(created.task_id, "waiting", now, runId)
              .run();
  
            await this.env.DB.prepare(
              `INSERT INTO actions (run_id, action, detail_json, created_at)
               VALUES (?, 'create_task', ?, ?)`,
            )
              .bind(
                runId,
                JSON.stringify({
                  task_id: created.task_id,
                  keyCount: keyIds.length,
                  keyIds,
                }),
                now,
              )
              .run();
  
            return created;
          });
  
      const maxMinutes = config.task_poll_max_minutes ?? 30;
      const maxPolls = Math.ceil((maxMinutes * 60) / 15);
  
      for (let i = 0; i < maxPolls; i++) {
        const status = await step.do(`poll-task-${i}`, async () => {
          const client = new LokaliseClient(this.env.LOKALISE_API_TOKEN);
          const t = await client.getTask(projectId, task.task_id);
          const now = new Date().toISOString();
          await this.env.DB.prepare(
            `INSERT INTO actions (run_id, action, detail_json, created_at)
             VALUES (?, 'poll_task', ?, ?)`,
          )
            .bind(
              runId,
              JSON.stringify({ task_id: task.task_id, status: t.status }),
              now,
            )
            .run();
          return t.status;
        });
  
        if (TERMINAL_OK.has(status)) break;
  
        if (TERMINAL_BAD.has(status)) {
          await step.do("mark-failed", async () => {
            const now = new Date().toISOString();
            await this.env.DB.prepare(
              `UPDATE runs SET status = ?, error = ?, updated_at = ? WHERE id = ?`,
            )
              .bind("failed", `Lokalise task status=${status}`, now, runId)
              .run();
          });
          throw new NonRetryableError(
            `Lokalise task ${task.task_id} status=${status}`,
          );
        }
  
        await step.sleep(`wait-${i}`, i < 4 ? "15 seconds" : "1 minute");
  
        if (i === maxPolls - 1) {
          await step.do("mark-timeout", async () => {
            const now = new Date().toISOString();
            await this.env.DB.prepare(
              `UPDATE runs SET status = ?, error = ?, updated_at = ? WHERE id = ?`,
            )
              .bind("failed", "task poll timeout", now, runId)
              .run();
          });
          throw new NonRetryableError("Task poll timeout");
        }
      }
  
      await step.do("mark-completed", async () => {
        const now = new Date().toISOString();
        await this.env.DB.prepare(
          `UPDATE runs SET status = ?, updated_at = ? WHERE id = ?`,
        )
          .bind("completed", now, runId)
          .run();
  
        await this.env.DB.prepare(
          `INSERT INTO actions (run_id, action, detail_json, created_at)
           VALUES (?, 'task_completed', ?, ?)`,
        )
          .bind(runId, JSON.stringify({ task_id: task.task_id }), now)
          .run();
      });
    }
  }