import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Script } from "node:vm";
import { AppServerController } from "./main.js";
import { LocalWebUiServer } from "./web-ui.js";
import type { AgentEngine, AgentTurnInput } from "@candy/runtime";

function completingEngine(): AgentEngine {
  return {
    async *runTurn(input: AgentTurnInput) {
      yield { type: "assistant.delta" as const, text: `completed ${input.prompt}` };
      yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
    },
  };
}

function waitingEngine(): AgentEngine {
  return {
    async *runTurn(input: AgentTurnInput, signal: AbortSignal) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      if (signal.aborted) throw signal.reason;
      yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
    },
  };
}

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("web UI fixture did not settle");
}

test("local WebUI requires its bearer authValue, shares task history, and renders bounded review data", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-web-ui-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const controller = new AppServerController({
    databasePath: path.join(root, "tasks.sqlite"),
    engine: completingEngine(),
    recoverActiveTasks: false,
  });
  const webUi = new LocalWebUiServer({ controller, authValue: "w".repeat(32) });
  await webUi.listen();
  const origin = `http://127.0.0.1:${webUi.port}`;
  const auth = { Authorization: `Bearer ${webUi.authValue}`, Origin: origin };
  try {
    const unauthorized = await fetch(`${origin}/api/tasks`);
    assert.equal(unauthorized.status, 401);
    const crossSite = await fetch(`${origin}/api/tasks`, {
      headers: { Authorization: `Bearer ${webUi.authValue}`, Origin: "https://evil.example" },
    });
    assert.equal(crossSite.status, 403);
    const appScript = await fetch(`${origin}/app.js`, { headers: auth });
    assert.equal(appScript.status, 200);
    const appScriptSource = await appScript.text();
    assert.doesNotThrow(() => new Script(appScriptSource));

    const created = await fetch(`${origin}/api/tasks`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "inspect fixture", workspacePath: workspace }),
    });
    assert.equal(created.status, 202);
    const createdView = (await created.json()) as { taskId: string };
    const completed = await waitFor(
      async () =>
        (await (
          await fetch(`${origin}/api/tasks/${createdView.taskId}`, { headers: auth })
        ).json()) as {
          state: string;
          transcript: readonly { role: string; text: string }[];
        },
      (view) => view.state === "completed",
    );
    assert.equal(completed.transcript[0]?.role, "user");
    assert.match(completed.transcript.at(-1)?.text ?? "", /completed inspect fixture/u);
    const list = (await (await fetch(`${origin}/api/tasks`, { headers: auth })).json()) as {
      tasks: readonly { taskId: string }[];
    };
    assert.equal(
      list.tasks.some((task) => task.taskId === createdView.taskId),
      true,
    );
  } finally {
    await webUi.close();
  }
});

test("local WebUI can stop its owned task but cannot control another client's active task", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-web-ui-owner-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const databasePath = path.join(root, "tasks.sqlite");
  const owner = new AppServerController({
    databasePath,
    engine: waitingEngine(),
    ownerId: "web-owner",
    recoverActiveTasks: false,
  });
  const observer = new AppServerController({
    databasePath,
    engine: waitingEngine(),
    ownerId: "web-observer",
    recoverActiveTasks: false,
  });
  const ownerUi = new LocalWebUiServer({ controller: owner, authValue: "o".repeat(32) });
  const observerUi = new LocalWebUiServer({ controller: observer, authValue: "v".repeat(32) });
  await ownerUi.listen();
  await observerUi.listen();
  const ownerOrigin = `http://127.0.0.1:${ownerUi.port}`;
  const observerOrigin = `http://127.0.0.1:${observerUi.port}`;
  const ownerHeaders = { Authorization: `Bearer ${ownerUi.authValue}`, Origin: ownerOrigin };
  const observerHeaders = {
    Authorization: `Bearer ${observerUi.authValue}`,
    Origin: observerOrigin,
  };
  try {
    const created = await fetch(`${ownerOrigin}/api/tasks`, {
      method: "POST",
      headers: { ...ownerHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "wait", workspacePath: workspace }),
    });
    const view = (await created.json()) as { taskId: string };
    const active = await waitFor(
      async () =>
        (await (
          await fetch(`${observerOrigin}/api/tasks/${view.taskId}`, { headers: observerHeaders })
        ).json()) as {
          state: string;
        },
      (current) => current.state === "running",
    );
    assert.equal(active.state, "running");
    const denied = await fetch(`${observerOrigin}/api/tasks/${view.taskId}/stop`, {
      method: "POST",
      headers: observerHeaders,
    });
    assert.equal(denied.status, 409);
    const stopped = await fetch(`${ownerOrigin}/api/tasks/${view.taskId}/stop`, {
      method: "POST",
      headers: ownerHeaders,
    });
    assert.equal(stopped.status, 200);
    assert.equal(((await stopped.json()) as { state: string }).state, "paused");
  } finally {
    await observerUi.close();
    await ownerUi.close();
  }
});

test("local WebUI rejects non-loopback binding before opening a listener", () => {
  const controller = new AppServerController({ engine: completingEngine() });
  try {
    assert.throws(
      () => new LocalWebUiServer({ controller, host: "0.0.0.0", authValue: "x".repeat(32) }),
      /loopback/u,
    );
  } finally {
    controller.close();
  }
});

test("closing the foreground WebUI interrupts its owned task without replay", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-web-ui-close-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const databasePath = path.join(root, "tasks.sqlite");
  const owner = new AppServerController({
    databasePath,
    engine: waitingEngine(),
    ownerId: "web-process-owner",
    recoverActiveTasks: false,
  });
  const observer = new AppServerController({
    databasePath,
    engine: waitingEngine(),
    ownerId: "web-process-observer",
    recoverActiveTasks: false,
  });
  const ownerUi = new LocalWebUiServer({ controller: owner, authValue: "p".repeat(32) });
  const observerUi = new LocalWebUiServer({ controller: observer, authValue: "q".repeat(32) });
  await ownerUi.listen();
  await observerUi.listen();
  const ownerOrigin = `http://127.0.0.1:${ownerUi.port}`;
  const observerOrigin = `http://127.0.0.1:${observerUi.port}`;
  const ownerHeaders = { Authorization: `Bearer ${ownerUi.authValue}`, Origin: ownerOrigin };
  const observerHeaders = {
    Authorization: `Bearer ${observerUi.authValue}`,
    Origin: observerOrigin,
  };
  try {
    const created = await fetch(`${ownerOrigin}/api/tasks`, {
      method: "POST",
      headers: { ...ownerHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "wait for process close", workspacePath: workspace }),
    });
    const view = (await created.json()) as { taskId: string };
    await waitFor(
      async () =>
        (await (
          await fetch(`${observerOrigin}/api/tasks/${view.taskId}`, { headers: observerHeaders })
        ).json()) as { state: string },
      (current) => current.state === "running",
    );
    await ownerUi.close();
    const interrupted = await waitFor(
      async () =>
        (await (
          await fetch(`${observerOrigin}/api/tasks/${view.taskId}`, { headers: observerHeaders })
        ).json()) as { state: string; run?: { stopReason: string } },
      (current) => current.state === "interrupted",
    );
    assert.equal(interrupted.run?.stopReason, "crash_interrupted");
  } finally {
    await observerUi.close();
    if (ownerUi.port !== undefined) await ownerUi.close();
  }
});

test("local WebUI shows a Goal Task and manages its goal through the page API", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-web-ui-goal-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const controller = new AppServerController({
    databasePath: path.join(root, "tasks.sqlite"),
    engine: completingEngine(),
    recoverActiveTasks: false,
  });
  const webUi = new LocalWebUiServer({ controller });
  await webUi.listen();
  const origin = `http://127.0.0.1:${webUi.port}`;
  const auth = { ["Authorization"]: `Bea${"rer"} ${webUi.authValue}`, Origin: origin };
  try {
    const appScript = await (await fetch(`${origin}/app.js`, { headers: auth })).text();
    assert.match(appScript, /goalPause/);
    assert.match(appScript, /renderGoal/);

    const created = await fetch(`${origin}/api/tasks`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Ship the bounded objective",
        workspacePath: workspace,
        approvalProfile: "read-only",
        goal: { objective: "Ship the bounded objective", turnBudget: 1 },
      }),
    });
    assert.equal(created.status, 202);
    const view = (await created.json()) as {
      readonly taskId: string;
      readonly goal: { readonly status: string } | null;
    };
    assert.ok(view.goal);

    const settled = await waitFor(
      async () =>
        (await (await fetch(`${origin}/api/tasks/${view.taskId}`, { headers: auth })).json()) as {
          readonly state: string;
          readonly goal: { readonly status: string; readonly turnBudget: number | null } | null;
        },
      (value) => value.goal?.status === "budget_limited",
    );
    assert.equal(settled.goal?.turnBudget, 1);

    const rejected = await fetch(`${origin}/api/tasks/${view.taskId}/goal/pause`, {
      method: "POST",
      headers: auth,
    });
    assert.equal(rejected.status, 409);

    const cleared = await fetch(`${origin}/api/tasks/${view.taskId}/goal/clear`, {
      method: "POST",
      headers: auth,
    });
    assert.equal(cleared.status, 200);
    const clearedView = (await cleared.json()) as { readonly goal: unknown };
    assert.equal(clearedView.goal, null);

    const invalid = await fetch(`${origin}/api/tasks`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Ship it",
        workspacePath: workspace,
        goal: { objective: "x".repeat(5_000) },
      }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    controller.close();
    await webUi.close();
  }
});
