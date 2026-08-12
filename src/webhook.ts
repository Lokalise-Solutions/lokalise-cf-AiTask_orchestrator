import type { Env, InboundQueueMessage } from "./types";

function secretsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export async function handleLokaliseWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const secret = request.headers.get("X-Secret") ?? "";
  if (!env.LOKALISE_WEBHOOK_SECRET || !secretsEqual(secret, env.LOKALISE_WEBHOOK_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Lokalise may send an empty/ping body when enabling the app — still return 2xx
  const text = await request.text();
  if (!text) {
    return new Response("ok", { status: 200 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const eventType = String(payload.event ?? "unknown");
  const project =
    (payload.project as { id?: string } | undefined)?.id ??
    request.headers.get("Project-Id") ??
    "unknown";
  const receivedAt = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO events (run_id, project_id, event_type, payload_json, received_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(null, project, eventType, text, receivedAt)
    .run();

  const message: InboundQueueMessage = {
    projectId: project,
    eventType,
    payload,
    receivedAt,
  };
  await env.INBOUND_QUEUE.send(message);

  return new Response("ok", { status: 200 });
}