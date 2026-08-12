import { DurableObject } from "cloudflare:workers";
import type { Env, InboundQueueMessage } from "./types";

type AggState = {
  runId: string | null;
  projectId: string;
  fingerprint: string | null;
  branch: string | null;
  filename: string | null;
  keyIds: number[];
  pendingKeyIds: number[];
  closed: boolean;
};

const DEFAULT_WINDOW_MS = 10_000;

export class UploadAggregator extends DurableObject<Env> {
  private async load(): Promise<AggState> {
    return (
      (await this.ctx.storage.get<AggState>("state")) ?? {
        runId: null,
        projectId: "",
        fingerprint: null,
        branch: null,
        filename: null,
        keyIds: [],
        pendingKeyIds: [],
        closed: false,
      }
    );
  }

  private async save(state: AggState): Promise<void> {
    await this.ctx.storage.put("state", state);
  }

  async handleEvent(
    msg: InboundQueueMessage,
  ): Promise<{ ok: boolean; runId?: string }> {
    const state = await this.load();
    state.projectId = msg.projectId;

    if (msg.eventType === "project.imported") {
      return this.onImported(state, msg);
    }

    if (
      msg.eventType === "project.keys.added" ||
      msg.eventType === "project.keys.modified"
    ) {
      return this.onKeys(state, msg);
    }

    return { ok: true };
  }

  private async onImported(state: AggState, msg: InboundQueueMessage) {
    const payload = msg.payload as {
      import?: { filename?: string };
      import_options?: { key_tags?: string[] };
      created_at_timestamp?: number;
      project?: { branch?: string };
    };

    const filename = payload.import?.filename ?? "unknown";
    const ts = payload.created_at_timestamp ?? Date.now();
    const branch =
      payload.import_options?.key_tags?.[0] ??
      payload.project?.branch ??
      null;
    const fingerprint = `${filename}|${ts}|${branch ?? ""}`;

    if (state.runId && state.fingerprint === fingerprint && !state.closed) {
      await this.ensureAlarm();
      return { ok: true, runId: state.runId };
    }

    const runId = crypto.randomUUID();
    const now = new Date().toISOString();

    try {
      await this.env.DB.prepare(
        `INSERT INTO runs (
           id, project_id, import_fingerprint, branch, filename, status,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'aggregating', ?, ?)`,
      )
        .bind(runId, msg.projectId, fingerprint, branch, filename, now, now)
        .run();
    } catch (err) {
      console.log("run insert skipped (likely duplicate)", String(err));
      return { ok: true, runId: state.runId ?? undefined };
    }

    state.runId = runId;
    state.fingerprint = fingerprint;
    state.branch = branch;
    state.filename = filename;
    state.closed = false;
    // New run only: pending keys for this window — never prior run keyIds
    state.keyIds = [...new Set(state.pendingKeyIds)];
    state.pendingKeyIds = [];

    await this.save(state);
    await this.linkRecentEvents(runId, msg.projectId);
    await this.ensureAlarm();

    return { ok: true, runId };
  }

  private async onKeys(state: AggState, msg: InboundQueueMessage) {
    const payload = msg.payload as {
      action?: string;
      keys?: Array<{ id?: number }>;
    };

    if (payload.action !== "import.file") {
      return { ok: true, runId: state.runId ?? undefined };
    }

    const ids = (payload.keys ?? [])
      .map((k) => k.id)
      .filter((id): id is number => typeof id === "number");

    // Buffer when no open run, or previous run already closed
    if (!state.runId || state.closed) {
      state.pendingKeyIds = [...new Set([...state.pendingKeyIds, ...ids])];
      await this.save(state);
      await this.ensureAlarm();
      return { ok: true };
    }

    state.keyIds = [...new Set([...state.keyIds, ...ids])];
    await this.save(state);
    await this.env.DB.prepare(
      `UPDATE events SET run_id = ? WHERE project_id = ? AND run_id IS NULL AND event_type = ?`,
    )
      .bind(state.runId, msg.projectId, msg.eventType)
      .run();

    await this.ensureAlarm();
    return { ok: true, runId: state.runId };
  }

  private async ensureAlarm(): Promise<void> {
    let windowMs = DEFAULT_WINDOW_MS;
    try {
      const state = await this.load();
      const raw = await this.env.CONFIG.get(`project:${state.projectId}`);
      if (raw) {
        const cfg = JSON.parse(raw) as { aggregation_window_ms?: number };
        if (cfg.aggregation_window_ms) windowMs = cfg.aggregation_window_ms;
      }
    } catch {
      /* keep default */
    }

    await this.ctx.storage.setAlarm(Date.now() + windowMs);
  }

  private async linkRecentEvents(runId: string, projectId: string) {
    await this.env.DB.prepare(
      `UPDATE events SET run_id = ?
       WHERE project_id = ? AND run_id IS NULL
         AND event_type IN ('project.imported', 'project.keys.added', 'project.keys.modified')`,
    )
      .bind(runId, projectId)
      .run();
  }

  async alarm(): Promise<void> {
    const state = await this.load();
    if (!state.runId || state.closed) return;

    // Capture BEFORE clearing DO state (critical)
    const runId = state.runId;
    const projectId = state.projectId;
    const branch = state.branch;
    const keyIds = [...state.keyIds];
    const nextStatus = keyIds.length > 0 ? "ready" : "skipped_empty";
    const now = new Date().toISOString();

    for (const keyId of keyIds) {
      await this.env.DB.prepare(
        `INSERT OR IGNORE INTO run_keys (run_id, key_id) VALUES (?, ?)`,
      )
        .bind(runId, keyId)
        .run();
    }

    await this.env.DB.prepare(
      `UPDATE runs SET status = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(nextStatus, now, runId)
      .run();

    await this.env.DB.prepare(
      `INSERT INTO actions (run_id, action, detail_json, created_at)
       VALUES (?, 'aggregate_complete', ?, ?)`,
    )
      .bind(
        runId,
        JSON.stringify({ keyCount: keyIds.length, branch }),
        now,
      )
      .run();

    state.closed = true;
    state.runId = null;
    state.keyIds = [];
    state.pendingKeyIds = [];
    await this.save(state);

    console.log(
      JSON.stringify({
        msg: "aggregation complete",
        runId,
        nextStatus,
        keyCount: keyIds.length,
        keyIds,
        branch,
      }),
    );

    if (nextStatus === "ready" && runId) {
      try {
        await this.env.TRANSLATE_WORKFLOW.create({
          id: `translate-${runId}`,
          params: { runId, projectId, branch, keyIds },
        });
        console.log(
          JSON.stringify({
            msg: "started workflow",
            workflowId: `translate-${runId}`,
            keyCount: keyIds.length,
            keyIds,
          }),
        );
      } catch (err) {
        console.log("workflow create skipped/failed", String(err));
      }
    }
  }
}