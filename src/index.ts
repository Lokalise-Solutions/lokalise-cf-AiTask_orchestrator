import type { Env, InboundQueueMessage } from "./types";
import { handleLokaliseWebhook } from "./webhook";
import { UploadAggregator } from "./upload-aggregator";
import { TranslateAiWorkflow } from "./workflows/translate-ai";
// Required: wrangler binds this class via [[durable_objects.bindings]]
export { UploadAggregator, TranslateAiWorkflow };



export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/webhooks/lokalise") {
      return handleLokaliseWebhook(request, env);
    }

    return new Response("Not found", { status: 404 });
  },

  async queue(
    batch: MessageBatch<InboundQueueMessage>,
    env: Env,
  ): Promise<void> {
    for (const msg of batch.messages) {
      try {
        const id = env.UPLOAD_AGGREGATOR.idFromName(msg.body.projectId);
        const stub = env.UPLOAD_AGGREGATOR.get(id) as DurableObjectStub &
          Pick<UploadAggregator, "handleEvent">;

        await stub.handleEvent(msg.body);
        msg.ack();
      } catch (err) {
        console.error("aggregator failed", err);
        msg.retry();
      }
    }
  },
};