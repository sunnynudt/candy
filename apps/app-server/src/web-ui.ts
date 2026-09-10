import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  isSafeTaskId,
  validateGoalSpec,
  type CandyModelId,
  type GoalSpec,
  type ProtocolMessage,
} from "@candy/protocol";
import {
  createDefaultAppServerController,
  type AppServerController,
  type AppServerTaskView,
} from "./main.js";

const MAX_BODY_BYTES = 32 * 1024;
const DEFAULT_HOST = "127.0.0.1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface LocalWebUiOptions {
  readonly controller: AppServerController;
  readonly host?: string;
  readonly port?: number;
  readonly token?: string;
}

export class LocalWebUiServer {
  readonly #controller: AppServerController;
  readonly #host: string;
  readonly #port: number;
  readonly #token: string;
  readonly #server: Server;
  #boundPort: number | undefined;

  public constructor(options: LocalWebUiOptions) {
    this.#controller = options.controller;
    this.#host = options.host ?? DEFAULT_HOST;
    this.#port = options.port ?? 0;
    this.#token = options.token ?? randomBytes(32).toString("base64url");
    if (!LOOPBACK_HOSTS.has(this.#host))
      throw new Error("Candy WebUI only permits loopback binding.");
    if (!/^[A-Za-z0-9_-]{32,}$/u.test(this.#token))
      throw new Error("Candy WebUI token is invalid.");
    this.#server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  public get token(): string {
    return this.#token;
  }

  public get port(): number | undefined {
    return this.#boundPort;
  }

  public get url(): string {
    if (this.#boundPort === undefined) throw new Error("Candy WebUI is not listening.");
    return `http://${this.#host === "::1" ? "[::1]" : this.#host}:${this.#boundPort}/?token=${this.#token}`;
  }

  public listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        this.#server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.#server.off("error", onError);
        const address = this.#server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("Candy WebUI did not receive a TCP address."));
          return;
        }
        this.#boundPort = address.port;
        resolve();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(this.#port, this.#host);
    });
  }

  public close(): Promise<void> {
    this.#controller.close();
    return new Promise((resolve, reject) => {
      if (!this.#server.listening) {
        resolve();
        return;
      }
      this.#server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${this.urlHost()}`);
      if (!this.originAllowed(request.headers.origin)) {
        this.sendJson(response, 403, { error: "cross_site_request_denied" });
        return;
      }

      if (requestUrl.pathname === "/" && request.method === "GET") {
        if (this.validToken(requestUrl.searchParams.get("token"))) {
          response.statusCode = 303;
          response.setHeader("Location", "/");
          response.setHeader("Set-Cookie", this.cookie());
          response.end();
          return;
        }
        if (!this.authorized(request)) {
          this.sendJson(response, 401, { error: "authorization_required" });
          return;
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'",
        );
        response.end(INDEX_HTML);
        return;
      }

      if (requestUrl.pathname === "/app.js" && request.method === "GET") {
        if (!this.authorized(request)) {
          this.sendJson(response, 401, { error: "authorization_required" });
          return;
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(APP_JS);
        return;
      }

      if (!this.authorized(request)) {
        this.sendJson(response, 401, { error: "authorization_required" });
        return;
      }

      if (requestUrl.pathname === "/api/tasks" && request.method === "GET") {
        this.sendJson(response, 200, { tasks: this.#controller.listTasks().map(taskSummary) });
        return;
      }

      if (requestUrl.pathname === "/api/tasks" && request.method === "POST") {
        await this.createTask(request, response);
        return;
      }

      const taskMatch =
        /^\/api\/tasks\/([^/]+)(?:\/(changes|stop|goal))?(?:\/(pause|resume|clear))?$/u.exec(
          requestUrl.pathname,
        );
      if (taskMatch === null || !isSafeTaskId(decodeURIComponent(taskMatch[1] ?? ""))) {
        this.sendJson(response, 404, { error: "not_found" });
        return;
      }
      const taskId = decodeURIComponent(taskMatch[1]!);
      const action = taskMatch[2];
      const goalAction = taskMatch[3];
      if (request.method === "GET" && (action === undefined || action === "changes")) {
        const view = await this.#controller.inspectTask(taskId);
        if (view === undefined) {
          this.sendJson(response, 404, { error: "task_not_found" });
          return;
        }
        this.sendJson(response, 200, action === "changes" ? view.changes : taskView(view));
        return;
      }
      if (request.method === "POST" && action === "stop") {
        try {
          await this.#controller.stopOwnedTask(taskId);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Task stop failed.";
          const status = message === "Task is owned by another client." ? 409 : 404;
          this.sendJson(response, status, {
            error: status === 409 ? "task_owned_by_another_client" : "task_stop_failed",
          });
          return;
        }
        const view = await this.#controller.inspectTask(taskId);
        this.sendJson(response, 200, view === undefined ? {} : taskView(view));
        return;
      }
      if (request.method === "POST" && action === "goal") {
        const goalCommand =
          goalAction === "pause"
            ? "goal.pause"
            : goalAction === "resume"
              ? "goal.resume"
              : goalAction === "clear"
                ? "goal.clear"
                : undefined;
        if (goalCommand === undefined) {
          this.sendJson(response, 400, { error: "invalid_goal_action" });
          return;
        }
        const current = await this.#controller.inspectTask(taskId);
        if (current === undefined) {
          this.sendJson(response, 404, { error: "task_not_found" });
          return;
        }
        try {
          await this.#controller.dispatch({
            v: 1,
            kind: "command",
            commandId: `web-goal-${taskId}-${Date.now()}`,
            taskId,
            expectedRevision: current.metadata.revision,
            command: { type: goalCommand },
          });
        } catch (error) {
          this.sendJson(response, 409, {
            error: "goal_command_rejected",
            message: error instanceof Error ? error.message : "Goal command rejected.",
          });
          return;
        }
        const updated = await this.#controller.inspectTask(taskId);
        this.sendJson(response, 200, updated === undefined ? {} : taskView(updated));
        return;
      }
      this.sendJson(response, 405, { error: "method_not_allowed" });
    } catch {
      if (!response.headersSent) this.sendJson(response, 400, { error: "bad_request" });
      else response.destroy();
    }
  }

  private async createTask(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      this.sendJson(response, 400, { error: "invalid_task_request" });
      return;
    }
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    const workspacePath = typeof body.workspacePath === "string" ? body.workspacePath : "";
    const approvalProfile = body.approvalProfile === "read-only" ? "read-only" : "auto";
    if (prompt.length === 0 || prompt.length > 100_000 || !path.isAbsolute(workspacePath)) {
      this.sendJson(response, 400, { error: "invalid_task_request" });
      return;
    }
    const taskId = `web-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
    const model = typeof body.model === "string" ? (body.model as CandyModelId) : undefined;
    let goalSpec: GoalSpec | undefined;
    if (body.goal !== undefined) {
      try {
        validateGoalSpec(body.goal, "goal");
        goalSpec = body.goal;
      } catch {
        this.sendJson(response, 400, { error: "invalid_goal_request" });
        return;
      }
    }
    const created = await this.#controller.dispatch({
      v: 1,
      kind: "command",
      commandId: `web-create-${taskId}`,
      taskId,
      expectedRevision: 0,
      command: {
        type: "task.create",
        prompt,
        approvalProfile,
        workspacePath,
        ...(model ? { model } : {}),
        ...(goalSpec === undefined ? {} : { goal: goalSpec }),
      },
    });
    const snapshot = findSnapshot(created);
    if (snapshot === undefined) throw new Error("Task creation did not return a snapshot.");
    await this.#controller.dispatch({
      v: 1,
      kind: "command",
      commandId: `web-run-${taskId}`,
      taskId,
      expectedRevision: snapshot.revision,
      command: { type: "task.run" },
    });
    const view = await this.#controller.inspectTask(taskId);
    this.sendJson(response, 202, view === undefined ? {} : taskView(view));
  }

  private authorized(request: IncomingMessage): boolean {
    const authorization = request.headers.authorization;
    if (authorization?.startsWith("Bearer ") && this.validToken(authorization.slice(7)))
      return true;
    const cookie = request.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("candy_web="))
      ?.slice("candy_web=".length);
    return this.validToken(cookie);
  }

  private validToken(value: string | null | undefined): boolean {
    if (value === undefined || value === null) return false;
    const actual = Buffer.from(value);
    const expected = Buffer.from(this.#token);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private originAllowed(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    const port = this.#boundPort;
    if (port === undefined) return false;
    return (
      origin === `http://${this.urlHost()}:${port}` ||
      (this.#host === "127.0.0.1" && origin === `http://localhost:${port}`)
    );
  }

  private urlHost(): string {
    return this.#host === "::1" ? "[::1]" : this.#host;
  }

  private cookie(): string {
    return `candy_web=${this.#token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`;
  }

  private sendJson(response: ServerResponse, status: number, value: unknown): void {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify(value));
  }
}

function taskSummary(task: ReturnType<AppServerController["listTasks"]>[number]): object {
  return {
    taskId: task.taskId,
    revision: task.revision,
    state: task.state,
    model: task.model,
    approvalProfile: task.approvalProfile,
    title: task.title ?? task.taskId,
    owner: task.ownerId === undefined ? "available" : "active",
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    goal:
      task.goal === undefined
        ? null
        : {
            status: task.goal.status,
            objective: task.goal.objective,
            completionCriterion: task.goal.completionCriterion ?? null,
            turnsUsed: task.goal.turnsUsed,
            turnBudget: task.goal.turnBudget,
            tokensUsed: task.goal.tokensUsed,
            tokenBudget: task.goal.tokenBudget,
            wallClockMs: task.goal.wallClockMs,
            wallClockBudgetMs: task.goal.wallClockBudgetMs,
            consecutiveNoProgress: task.goal.consecutiveNoProgress,
            terminalReason: task.goal.terminalReason ?? null,
          },
  };
}

function taskView(view: AppServerTaskView): object {
  return {
    ...taskSummary(view.metadata),
    transcript: view.transcript,
    run: view.run,
    changes: view.changes,
    review: view.review,
  };
}

function findSnapshot(
  messages: readonly ProtocolMessage[],
): { readonly revision: number } | undefined {
  const message = messages.find(
    (candidate): candidate is Extract<ProtocolMessage, { kind: "event" }> =>
      candidate.kind === "event" && candidate.event.type === "snapshot",
  );
  return message?.event.type === "snapshot" ? message.event.snapshot : undefined;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Candy WebUI</title><style>
:root{font-family:ui-sans-serif,system-ui,sans-serif;color:#202124;background:#f7f7f5}body{margin:0}main{display:grid;grid-template-columns:280px 1fr;min-height:100vh}aside{border-right:1px solid #ddd;padding:18px;background:#fff}section{padding:22px;max-width:1000px}button{border:1px solid #999;border-radius:6px;background:#fff;padding:7px 10px;cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}ul{padding:0;list-style:none}li{margin:6px 0}li button{width:100%;text-align:left}.selected{background:#e9eefc}pre{white-space:pre-wrap;overflow:auto;background:#fff;border:1px solid #ddd;padding:12px;border-radius:6px}.muted{color:#666}.danger{color:#9b1c1c}.meta{display:flex;gap:10px;flex-wrap:wrap}.meta span{background:#e8e8e5;padding:4px 7px;border-radius:4px;font-size:12px}
</style></head><body><main><aside><h1>Candy</h1><p class="muted">Local WebUI</p><button id="refresh">Refresh</button><ul id="tasks"></ul></aside><section><div id="empty" class="muted">Select a task to inspect its conversation and changes.</div><article id="detail" hidden><h2 id="title"></h2><div id="meta" class="meta"></div><p><button id="stop" class="danger">Stop owned task</button> <span id="status" class="muted"></span></p><div id="goalPanel" hidden><h3>Goal</h3><div id="goal"></div><p><button id="goalPause">Pause goal</button> <button id="goalResume">Resume goal</button> <button id="goalClear" class="danger">Clear goal</button> <span id="goalStatus" class="muted"></span></p></div><h3>Conversation</h3><pre id="conversation"></pre><h3>Changed files and diff</h3><pre id="changes"></pre></article></section></main><script src="/app.js" defer></script></body></html>`;

const APP_JS = `const tasks=document.querySelector('#tasks');const refresh=document.querySelector('#refresh');const empty=document.querySelector('#empty');const detail=document.querySelector('#detail');const title=document.querySelector('#title');const meta=document.querySelector('#meta');const conversation=document.querySelector('#conversation');const changes=document.querySelector('#changes');const stop=document.querySelector('#stop');const status=document.querySelector('#status');const goalPanel=document.querySelector('#goalPanel');const goal=document.querySelector('#goal');const goalPause=document.querySelector('#goalPause');const goalResume=document.querySelector('#goalResume');const goalClear=document.querySelector('#goalClear');const goalStatus=document.querySelector('#goalStatus');let selected='';
async function api(path,options){const response=await fetch(path,options);const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'request failed');return data}
function text(value){return document.createTextNode(String(value??''))}
function renderTasks(items){tasks.replaceChildren();for(const task of items){const li=document.createElement('li');const button=document.createElement('button');button.textContent=task.title+' · '+task.state;button.className=task.taskId===selected?'selected':'';button.onclick=()=>load(task.taskId);li.append(button);tasks.append(li)}}
async function load(id){selected=id;try{const view=await api('/api/tasks/'+encodeURIComponent(id));empty.hidden=true;detail.hidden=false;title.textContent=view.title;meta.replaceChildren();for(const value of [view.state,view.model,view.approvalProfile,view.owner]){const span=document.createElement('span');span.append(text(value));meta.append(span)}stop.disabled=view.owner!=='active'||!['running','waiting_approval'].includes(view.state);status.textContent=stop.disabled?'Only the owning WebUI process can stop an active task.':'';renderGoal(view.goal);renderGoal(view.goal);conversation.textContent=view.transcript.map(entry=>entry.role+': '+entry.text).join('\\n\\n');const c=view.changes;changes.textContent='tracked: '+c.tracked.join(', ')+'\\nuntracked: '+c.untracked.join(', ')+'\\n\\n'+c.patchText;renderTasks((await api('/api/tasks')).tasks)}catch(error){status.textContent=error.message}}
async function refreshTasks(){try{const data=await api('/api/tasks');renderTasks(data.tasks);if(selected)await load(selected)}catch(error){status.textContent=error.message}}stop.onclick=async()=>{if(!selected)return;try{await api('/api/tasks/'+encodeURIComponent(selected)+'/stop',{method:'POST'});await load(selected)}catch(error){status.textContent=error.message}};function renderGoal(value){goalPanel.hidden=!value;if(!value){goal.replaceChildren();goalStatus.textContent='';return}goal.replaceChildren();for(const item of [value.status+' · '+value.turnsUsed+(value.turnBudget===null?'':'/'+value.turnBudget)+' turns · '+value.tokensUsed+(value.tokenBudget===null?'':'/'+value.tokenBudget)+' tokens',value.objective,value.completionCriterion?('criterion: '+value.completionCriterion):'',value.terminalReason?('reason: '+value.terminalReason):'']){if(!item)continue;const line=document.createElement('div');line.append(text(item));goal.append(line)}goalPause.disabled=value.status!=='active';goalResume.disabled=value.status!=='paused'&&value.status!=='blocked';goalStatus.textContent=''}
async function goalAction(action){if(!selected)return;try{await api('/api/tasks/'+encodeURIComponent(selected)+'/goal/'+action,{method:'POST'});await load(selected)}catch(error){goalStatus.textContent=error.message}}
goalPause.onclick=()=>goalAction('pause');goalResume.onclick=()=>goalAction('resume');goalClear.onclick=()=>goalAction('clear');refresh.onclick=refreshTasks;refreshTasks();setInterval(refreshTasks,1500);`;

export async function runWebUi(): Promise<void> {
  const controller = createDefaultAppServerController({ recoverActiveTasks: false });
  const webUi = new LocalWebUiServer({ controller });
  await webUi.listen();
  process.stdout.write(`Candy WebUI listening at ${webUi.url}\n`);
  const close = (): void => {
    void webUi.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runWebUi();
