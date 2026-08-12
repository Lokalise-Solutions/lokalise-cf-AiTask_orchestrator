export type LokaliseTask = {
    task_id: number;
    status: string;
    title?: string;
  };
  
  export class LokaliseClient {
    constructor(private apiToken: string) {}
  
    private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await fetch(`https://api.lokalise.com/api2${path}`, {
        method,
        headers: {
          "X-Api-Token": this.apiToken,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      console.log(
        JSON.stringify({
          msg: "lokalise:api-response",
          method,
          path,
          status: res.status,
          ok: res.ok,
          body: text,
        }),
      );
      if (!res.ok) {
        throw new Error(`Lokalise ${method} ${path} → ${res.status}: ${text}`);
      }
      return text ? (JSON.parse(text) as T) : ({} as T);
    }
  
    async createAutomaticTranslationTask(input: {
      projectId: string;
      title: string;
      description?: string;
      sourceLang: string;
      targetLangs: string[];
      keyIds: number[];
    }): Promise<LokaliseTask> {
      const payload = {
        title: input.title,
        description: input.description ?? "Auto-created by lokalise-cf-orchestrator",
        keys: input.keyIds,
        source_language_iso: input.sourceLang,
        languages: input.targetLangs.map((language_iso) => ({ language_iso })),
        task_type: "automatic_translation",
        apply_ai_tm100_matches: true,
      };
      console.log(
        JSON.stringify({
          msg: "lokalise:create-task:request",
          projectId: input.projectId,
          keyCount: input.keyIds.length,
          keyIds: input.keyIds,
          payload,
        }),
      );
      const data = await this.request<{ task: LokaliseTask }>(
        "POST",
        `/projects/${input.projectId}/tasks`,
        payload,
      );
      console.log(
        JSON.stringify({
          msg: "lokalise:create-task:parsed",
          task: data.task,
        }),
      );
      return data.task;
    }
  
    async getTask(projectId: string, taskId: number): Promise<LokaliseTask> {
      const data = await this.request<{ task: LokaliseTask }>(
        "GET",
        `/projects/${projectId}/tasks/${taskId}`,
      );
      return data.task;
    }
  }