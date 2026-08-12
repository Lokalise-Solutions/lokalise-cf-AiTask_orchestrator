export type Env = {
    DB: D1Database;
    CONFIG: KVNamespace;
    INBOUND_QUEUE: Queue;
    UPLOAD_AGGREGATOR: DurableObjectNamespace;
    TRANSLATE_WORKFLOW: Workflow;
    LOKALISE_WEBHOOK_SECRET: string;
    LOKALISE_API_TOKEN: string;
  };
  
  export type InboundQueueMessage = {
    projectId: string;
    eventType: string;
    payload: unknown;
    receivedAt: string;
  };
  
  export type ProjectConfig = {
    enabled: boolean;
    source_lang: string;
    target_langs: string[];
    aggregation_window_ms?: number;
    task_poll_max_minutes?: number;
  };
  
  export type TranslateWorkflowParams = {
    runId: string;
    projectId: string;
    branch: string | null;
    keyIds: number[];
  };