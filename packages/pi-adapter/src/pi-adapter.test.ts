import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CandyPiSessionStore,
  createCandyWorkspaceTools,
  createCandyWorkspaceOperations,
  DeepSeekClient,
  MiniMaxClient,
  MiniMaxPiAgentEngine,
  MODEL_CATALOG,
  PI_COMPATIBILITY_VERSION,
  listPiPublicExports,
  PiAgentEngine,
  type PiAgentObservation,
  projectPiLifecycleObservation,
  projectPiToolObservation,
  parseMiniMaxSseLine,
  parseDeepSeekSseLine,
  ProviderContractError,
} from "./index.js";
import { createCandyBashOperations, createCandyNetworkToolDefinition } from "./index.js";
import { CandyRestrictedResourceLoader } from "./restricted-resource-loader.js";

test("pinned Pi root SDK export imports under the runtime baseline", () => {
  assert.equal(PI_COMPATIBILITY_VERSION, "0.84.1");
  assert.ok(listPiPublicExports().length > 0);
});

test("Pi tool lifecycle projections expose bounded redacted arguments and output", () => {
  const start = projectPiToolObservation(
    {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "candy_read",
      args: { path: "src/value.ts", token: "sk-proj-tool-canary-1234567890" },
    },
    "task-tools",
    ["fixture-secret"],
  );
  const update = projectPiToolObservation(
    {
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "candy_read",
      args: { path: "src/value.ts" },
      partialResult: { content: [{ type: "text", text: "partial output" }] },
    },
    "task-tools",
    ["fixture-secret"],
  );
  const end = projectPiToolObservation(
    {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "candy_read",
      result: { content: [{ type: "text", text: "Bearer fixture-secret" }] },
      isError: false,
    },
    "task-tools",
    ["fixture-secret"],
  );
  assert.equal(start.type, "tool.started");
  assert.match(start.args ?? "", /src\/value\.ts/u);
  assert.doesNotMatch(start.args ?? "", /sk-proj-tool-canary/u);
  assert.equal(update.type, "tool.updated");
  assert.match(update.output, /partial output/u);
  assert.equal(end.type, "tool.completed");
  assert.match(end.output ?? "", /\[REDACTED\]/u);
  assert.doesNotMatch(end.output ?? "", /fixture-secret/u);
});

test("Candy workspace tools expose file CRUD only in Auto and confirm deletes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-workspace-crud-"));
  const outside = await mkdtemp(path.join(tmpdir(), "candy-workspace-crud-outside-"));
  try {
    await writeFile(path.join(root, "obsolete.ts"), "obsolete\n");
    await writeFile(path.join(root, "denied.ts"), "keep\n");
    await writeFile(path.join(outside, "outside.ts"), "outside\n");
    const linkedPath = process.platform === "win32" ? "linked" : "linked.ts";
    await symlink(
      process.platform === "win32" ? outside : path.join(outside, "outside.ts"),
      path.join(root, linkedPath),
      ...(process.platform === "win32" ? (["junction"] as const) : []),
    );

    const readOnly = createCandyWorkspaceTools(root, "read-only");
    assert.deepEqual(
      readOnly.map((tool) => tool.name),
      ["candy_list", "candy_search", "candy_read"],
    );

    const requested: string[] = [];
    const auto = createCandyWorkspaceTools(root, "auto", undefined, async ({ path: filePath }) => {
      requested.push(filePath);
      return filePath === "obsolete.ts";
    });
    assert.deepEqual(
      auto.map((tool) => tool.name),
      ["candy_list", "candy_search", "candy_read", "candy_edit", "candy_write", "candy_delete"],
    );
    const deleteTool = auto.find((tool) => tool.name === "candy_delete");
    assert.ok(deleteTool);
    const signal = new AbortController().signal;
    await deleteTool.execute(
      "delete-approved",
      { path: "obsolete.ts" },
      signal,
      undefined,
      {} as never,
    );
    await assert.rejects(access(path.join(root, "obsolete.ts")), /ENOENT/u);
    await assert.rejects(
      deleteTool.execute("delete-denied", { path: "denied.ts" }, signal, undefined, {} as never),
      /denied/u,
    );
    assert.equal(await readFile(path.join(root, "denied.ts"), "utf8"), "keep\n");
    await assert.rejects(
      deleteTool.execute("delete-symlink", { path: linkedPath }, signal, undefined, {} as never),
      /Symbolic links/u,
    );
    await assert.rejects(
      deleteTool.execute(
        "delete-outside",
        { path: "../outside.ts" },
        signal,
        undefined,
        {} as never,
      ),
      /escaped/u,
    );
    await assert.rejects(
      deleteTool.execute(
        "delete-control-character",
        { path: "denied.ts\n:approve fake" },
        signal,
        undefined,
        {} as never,
      ),
      /control characters/u,
    );
    assert.deepEqual(requested, ["obsolete.ts", "denied.ts"]);

    const changedDuringApproval = createCandyWorkspaceTools(root, "auto", undefined, async () => {
      await writeFile(path.join(root, "denied.ts"), "changed\n");
      return true;
    }).find((tool) => tool.name === "candy_delete");
    assert.ok(changedDuringApproval);
    await assert.rejects(
      changedDuringApproval.execute(
        "delete-changed",
        { path: "denied.ts" },
        signal,
        undefined,
        {} as never,
      ),
      /changed while deletion approval was pending/u,
    );
    assert.equal(await readFile(path.join(root, "denied.ts"), "utf8"), "changed\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Candy workspace tools redact reads and reject credential-bearing writes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-workspace-credential-tools-"));
  try {
    await writeFile(path.join(root, "secret.txt"), "before fixture-secret after\n");
    const tools = createCandyWorkspaceTools(root, "auto", undefined, undefined, ["fixture-secret"]);
    const read = tools.find((tool) => tool.name === "candy_read");
    const write = tools.find((tool) => tool.name === "candy_write");
    assert.ok(read);
    assert.ok(write);
    const readResult = await read.execute(
      "read-secret",
      { path: "secret.txt" },
      new AbortController().signal,
      undefined,
      {} as never,
    );
    const readText = readResult.content
      .filter(
        (content): content is { readonly type: "text"; readonly text: string } =>
          content.type === "text",
      )
      .map((content) => content.text)
      .join("\n");
    assert.doesNotMatch(readText, /fixture-secret/u);
    assert.match(readText, /\[REDACTED\]/u);
    await assert.rejects(
      write.execute(
        "write-secret",
        { path: "new.txt", content: "fixture-secret" },
        new AbortController().signal,
        undefined,
        {} as never,
      ),
      /credentials/iu,
    );
    assert.equal(
      await readFile(path.join(root, "new.txt"), "utf8").catch(() => undefined),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Candy workspace browse tools stay bounded and inside the selected workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-workspace-browse-"));
  const outside = await mkdtemp(path.join(tmpdir(), "candy-workspace-browse-outside-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "docs"), { recursive: true });
    await mkdir(path.join(root, ".git"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "fixture"), { recursive: true });
    await mkdir(path.join(root, "app-data"), { recursive: true });
    await writeFile(path.join(root, "src", "main.ts"), "const first = 1;\nneedle here\n");
    await writeFile(path.join(root, "docs", "guide.md"), "needle in docs\n");
    await writeFile(path.join(root, ".git", "ignored.txt"), "needle in git\n");
    await writeFile(path.join(root, "node_modules", "fixture", "ignored.js"), "needle in deps\n");
    await writeFile(path.join(root, "app-data", "ignored.txt"), "needle in app data\n");
    await writeFile(path.join(root, "binary.dat"), Buffer.from([0, 1, 2, 3, 4]));
    await writeFile(path.join(outside, "secret.txt"), "needle outside\n");
    await symlink(
      process.platform === "win32" ? outside : path.join(outside, "secret.txt"),
      path.join(root, process.platform === "win32" ? "linked" : "linked.txt"),
      ...(process.platform === "win32" ? (["junction"] as const) : []),
    );

    const tools = createCandyWorkspaceTools(root, "read-only");
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["candy_list", "candy_search", "candy_read"],
    );
    const listTool = tools.find((tool) => tool.name === "candy_list");
    const searchTool = tools.find((tool) => tool.name === "candy_search");
    assert.ok(listTool);
    assert.ok(searchTool);
    assert.deepEqual(
      Object.keys((listTool.parameters as { properties: Record<string, unknown> }).properties),
      ["path"],
    );
    assert.deepEqual(
      Object.keys((searchTool.parameters as { properties: Record<string, unknown> }).properties),
      ["query", "path"],
    );

    const signal = new AbortController().signal;
    const listResult = await listTool.execute(
      "list",
      { path: "." },
      signal,
      undefined,
      {} as never,
    );
    const listContent = listResult.content[0];
    assert.ok(listContent?.type === "text");
    const listed = JSON.parse(String(listContent.text)) as {
      entries: { path: string; kind: string }[];
    };
    assert.deepEqual(listed.entries, [
      { path: "binary.dat", kind: "file" },
      { path: "docs", kind: "directory" },
      { path: "src", kind: "directory" },
    ]);

    const searchResult = await searchTool.execute(
      "search",
      { query: "needle" },
      signal,
      undefined,
      {} as never,
    );
    const searchContent = searchResult.content[0];
    assert.ok(searchContent?.type === "text");
    const searched = JSON.parse(String(searchContent.text)) as {
      matches: { path: string; line: number; column: number; text: string }[];
      truncated: boolean;
    };
    assert.deepEqual(
      searched.matches.map((match) => [match.path, match.line, match.column]),
      [
        ["docs/guide.md", 1, 1],
        ["src/main.ts", 2, 1],
      ],
    );
    assert.equal(searched.truncated, false);
    assert.doesNotMatch(JSON.stringify(searched), /outside|ignored|secret/u);

    await assert.rejects(
      listTool.execute(
        "escape",
        { path: "../candy-workspace-browse-outside" },
        signal,
        undefined,
        {} as never,
      ),
      /escaped/u,
    );
    await assert.rejects(
      searchTool.execute("control", { query: "needle\n" }, signal, undefined, {} as never),
      /control characters/u,
    );

    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      searchTool.execute(
        "cancelled",
        { query: "needle" },
        cancelled.signal,
        undefined,
        {} as never,
      ),
      /aborted/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Candy workspace search skips invalid text and caps serialized results", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-workspace-browse-bounds-"));
  try {
    await writeFile(path.join(root, "long.txt"), `needle ${"x".repeat(100_000)}\n`);
    await writeFile(path.join(root, "invalid.txt"), Buffer.from([0xc3, 0x28, 0x0a]));
    await writeFile(path.join(root, "credentials.txt"), "token fixture-secret\n");
    const searchTool = createCandyWorkspaceTools(root, "read-only").find(
      (tool) => tool.name === "candy_search",
    );
    assert.ok(searchTool);
    const result = await searchTool.execute(
      "bounded",
      { query: "needle" },
      new AbortController().signal,
      undefined,
      {} as never,
    );
    const content = result.content[0];
    assert.ok(content?.type === "text");
    const text = String(content.text);
    assert.ok(Buffer.byteLength(text, "utf8") <= 64 * 1024);
    const parsed = JSON.parse(text) as {
      matches: { text: string }[];
      truncated: boolean;
    };
    assert.equal(parsed.truncated, true);
    assert.ok(parsed.matches.every((match) => match.text.length <= 2_048));

    const secretSafeSearchTool = createCandyWorkspaceTools(
      root,
      "read-only",
      undefined,
      undefined,
      ["fixture-secret"],
    ).find((tool) => tool.name === "candy_search");
    assert.ok(secretSafeSearchTool);
    const secretSafeResult = await secretSafeSearchTool.execute(
      "secret-safe",
      { query: "token" },
      new AbortController().signal,
      undefined,
      {} as never,
    );
    const secretSafeContent = secretSafeResult.content[0];
    assert.ok(secretSafeContent?.type === "text");
    assert.doesNotMatch(secretSafeContent.text, /fixture-secret/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider catalog keeps domestic endpoints and live capabilities gated", () => {
  assert.deepEqual(
    MODEL_CATALOG.map((entry) => [entry.modelId, entry.endpoint, entry.enabled]),
    [
      ["deepseek-v4-flash", "https://api.deepseek.com/chat/completions", false],
      ["deepseek-v4-pro", "https://api.deepseek.com/chat/completions", false],
      ["MiniMax-M3", "https://api.minimaxi.com/anthropic/v1/messages", false],
    ],
  );
});

test("DeepSeek SSE parser projects text and completion without retaining auth", () => {
  assert.deepEqual(parseDeepSeekSseLine('data: {"choices":[{"delta":{"content":"hello"}}]}'), {
    text: "hello",
    done: false,
  });
  assert.deepEqual(parseDeepSeekSseLine("data: [DONE]"), { done: true });
});

test("DeepSeek client uses only the approved endpoint and releases a secret lease", async () => {
  let released = false;
  let request: { input: string; init: RequestInit } | undefined;
  const client = new DeepSeekClient(
    async () => ({ secret: "fixture-secret", release: () => (released = true) }),
    async (input, init) => {
      request = { input, init };
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  );
  const chunks = [];
  for await (const chunk of client.stream(
    { model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], stream: true },
    new AbortController().signal,
  ))
    chunks.push(chunk);
  assert.equal(request?.input, "https://api.deepseek.com/chat/completions");
  assert.equal(request?.init.redirect, "error");
  assert.match(
    String(request?.init.headers && (request.init.headers as Record<string, string>).authorization),
    /^Bearer /u,
  );
  assert.deepEqual(chunks, [{ text: "ok", done: false }, { done: true }]);
  assert.equal(released, true);
});

test("DeepSeek controlled provider failures expose only sanitized reasons", async () => {
  const cases = [
    {
      status: 401,
      reason: "unauthorized",
      transport: async () => new Response(null, { status: 401 }),
    },
    {
      status: 429,
      reason: "rate_limited",
      transport: async () => new Response(null, { status: 429 }),
    },
    {
      status: 0,
      reason: "timeout",
      transport: async () => {
        const error = new Error("fixture timeout with secret fixture-secret");
        error.name = "TimeoutError";
        throw error;
      },
    },
  ] as const;

  for (const fixture of cases) {
    let released = false;
    const client = new DeepSeekClient(
      async () => ({ secret: "fixture-secret", release: () => (released = true) }),
      fixture.transport,
    );
    let caught: unknown;
    try {
      for await (const _delta of client.stream(
        {
          model: "deepseek-v4-flash",
          messages: [{ role: "user", content: "fixture" }],
          stream: true,
        },
        new AbortController().signal,
      )) {
        // The controlled error must happen before a provider delta is exposed.
        void _delta;
      }
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof ProviderContractError);
    assert.equal(caught.code, "provider_error");
    assert.equal(caught.reason, fixture.reason);
    assert.doesNotMatch(caught.message, /fixture-secret/u);
    assert.equal(released, true);
  }
});

test("MiniMax parser and client remain domestic-only and release the secret lease", async () => {
  assert.deepEqual(
    parseMiniMaxSseLine(
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
    ),
    { text: "ok", done: false },
  );
  assert.deepEqual(parseMiniMaxSseLine('data: {"type":"message_stop"}'), { done: true });
  let released = false;
  let request: { input: string; init: RequestInit } | undefined;
  const client = new MiniMaxClient(
    async () => ({ secret: "fixture-secret", release: () => (released = true) }),
    async (input, init) => {
      request = { input, init };
      return new Response(
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\ndata: {"type":"message_stop"}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    },
  );
  const chunks = [];
  for await (const chunk of client.stream(
    {
      model: "MiniMax-M3",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      max_tokens: 32,
      stream: true,
    },
    new AbortController().signal,
  ))
    chunks.push(chunk);
  assert.equal(request?.input, "https://api.minimaxi.com/anthropic/v1/messages");
  assert.equal(request?.init.redirect, "error");
  assert.deepEqual(chunks, [{ text: "ok", done: false }, { done: true }]);
  assert.equal(released, true);
});

test("Pi agent engine uses public Candy workspace tools and Candy-owned sessions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-pi-engine-"));
  const originalFetch = globalThis.fetch;
  const requestBodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      'data: {"choices":[{"delta":{"reasoning_content":"thinking","content":"hello"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const observations: PiAgentObservation[] = [];
    for await (const observation of new PiAgentEngine(root, async () => ({
      secret: "fixture-secret",
      release: () => undefined,
    })).runTurn(
      {
        taskId: "task-1",
        prompt: "say hello",
        model: "deepseek-v4-flash",
        cwd: process.cwd(),
        thinkingLevel: "high",
      },
      new AbortController().signal,
    )) {
      observations.push(observation);
    }
    assert.deepEqual(
      observations.map((observation) => observation.type),
      [
        "turn.started",
        "assistant.delta",
        "assistant.thinking.delta",
        "turn.settled",
        "turn.completed",
      ],
    );
    const entries = await readdir(path.join(root, "task-1"));
    const sessionFile = entries.find((entry) => entry.endsWith(".jsonl"));
    assert.ok(sessionFile);
    const files = await readFile(path.join(root, "task-1", sessionFile), "utf8");
    assert.doesNotMatch(files, /fixture-secret/u);

    const autoObservations = [];
    for await (const observation of new PiAgentEngine(root, async () => ({
      secret: "fixture-secret",
      release: () => undefined,
    })).runTurn(
      {
        taskId: "task-auto",
        prompt: "say hello",
        model: "deepseek-v4-flash",
        cwd: process.cwd(),
        approvalProfile: "auto",
        fileDeleteApproval: async () => false,
      },
      new AbortController().signal,
    )) {
      autoObservations.push(observation);
    }
    assert.ok(autoObservations.some((observation) => observation.type === "turn.completed"));
    const autoRequest = requestBodies.at(-1);
    const toolNames = (autoRequest?.tools as { function?: { name?: string } }[]).map(
      (tool) => tool.function?.name,
    );
    assert.deepEqual(toolNames, [
      "candy_list",
      "candy_search",
      "candy_read",
      "candy_edit",
      "candy_write",
      "candy_delete",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Pi agent engine projects retry lifecycle and settles only after retry success", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-pi-retry-lifecycle-"));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) return new Response(null, { status: 429 });
    return new Response(
      'data: {"choices":[{"delta":{"content":"recovered"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };

  try {
    const observations: PiAgentObservation[] = [];
    for await (const observation of new PiAgentEngine(root, async () => ({
      secret: "fixture-secret",
      release: () => undefined,
    })).runTurn(
      {
        taskId: "task-retry-lifecycle",
        prompt: "recover this turn",
        model: "deepseek-v4-flash",
        cwd: process.cwd(),
      },
      new AbortController().signal,
    )) {
      observations.push(observation);
    }

    assert.equal(requests, 2);
    assert.deepEqual(
      observations.map((observation) => observation.type),
      [
        "turn.started",
        "turn.retrying",
        "assistant.delta",
        "turn.retry.completed",
        "turn.settled",
        "turn.completed",
      ],
    );
    const retry = observations.find((observation) => observation.type === "turn.retrying");
    assert.ok(retry && retry.attempt === 1 && retry.maxAttempts >= 1);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi agent engine compacts context overflow before continuing the turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-pi-overflow-compaction-"));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const stream = (content: string, finishReason: "length" | "stop"): string =>
    `data: ${JSON.stringify({
      model: "deepseek-v4-flash",
      choices: [{ delta: { content }, finish_reason: finishReason }],
    })}\n\ndata: [DONE]\n\n`;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) return new Response(stream("x".repeat(100_000), "stop"));
    if (requests === 3) return new Response(stream("partial", "length"));
    return new Response(stream(requests === 4 ? "summary" : "recovered", "stop"));
  };

  const runTurn = async (prompt: string): Promise<PiAgentObservation[]> => {
    const observations: PiAgentObservation[] = [];
    for await (const observation of new PiAgentEngine(root, async () => ({
      secret: "fixture-secret",
      release: () => undefined,
    })).runTurn(
      {
        taskId: "task-overflow-compaction",
        prompt,
        model: "deepseek-v4-flash",
        cwd: process.cwd(),
      },
      new AbortController().signal,
    )) {
      observations.push(observation);
    }
    return observations;
  };

  try {
    await runTurn("first turn");
    await runTurn("second turn");
    const observations = await runTurn("third turn");
    assert.equal(requests, 5);
    assert.deepEqual(
      observations.map((observation) => observation.type),
      [
        "turn.started",
        "assistant.delta",
        "turn.compaction",
        "turn.compaction",
        "assistant.delta",
        "turn.settled",
        "turn.completed",
      ],
    );
    assert.deepEqual(observations[2], {
      type: "turn.compaction",
      taskId: "task-overflow-compaction",
      phase: "started",
      reason: "overflow",
    });
    assert.deepEqual(observations[3], {
      type: "turn.compaction",
      taskId: "task-overflow-compaction",
      phase: "completed",
      reason: "overflow",
      aborted: false,
      willRetry: true,
    });
    assert.equal(observations[4]?.type, "assistant.delta");
    assert.equal((observations[4] as { text?: string }).text, "recovered");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi agent engine cancels an unsettled context compaction", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-pi-compaction-cancel-"));
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let requests = 0;
  const stream = (content: string, finishReason: "length" | "stop"): string =>
    `data: ${JSON.stringify({
      model: "deepseek-v4-flash",
      choices: [{ delta: { content }, finish_reason: finishReason }],
    })}\n\ndata: [DONE]\n\n`;
  globalThis.fetch = async (_input, init) => {
    requests += 1;
    if (requests === 1) return new Response(stream("x".repeat(100_000), "stop"));
    if (requests === 2) return new Response(stream("second", "stop"));
    if (requests === 3) return new Response(stream("partial", "length"));
    if (requests === 4) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const onAbort = (): void =>
          reject(new DOMException("The operation was aborted.", "AbortError"));
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    return new Response(stream("unexpected", "stop"));
  };

  const runTurn = async (prompt: string): Promise<PiAgentObservation[]> => {
    const observations: PiAgentObservation[] = [];
    for await (const observation of new PiAgentEngine(root, async () => ({
      secret: "fixture-secret",
      release: () => undefined,
    })).runTurn(
      {
        taskId: "task-compaction-cancel",
        prompt,
        model: "deepseek-v4-flash",
        cwd: process.cwd(),
      },
      controller.signal,
    )) {
      observations.push(observation);
    }
    return observations;
  };

  try {
    await runTurn("first turn");
    await runTurn("second turn");
    const observations: PiAgentObservation[] = [];
    await assert.rejects(
      (async () => {
        for await (const observation of new PiAgentEngine(root, async () => ({
          secret: "fixture-secret",
          release: () => undefined,
        })).runTurn(
          {
            taskId: "task-compaction-cancel",
            prompt: "third turn",
            model: "deepseek-v4-flash",
            cwd: process.cwd(),
          },
          controller.signal,
        )) {
          observations.push(observation);
          if (observation.type === "turn.compaction" && observation.phase === "started") {
            await new Promise<void>((resolve) => setImmediate(resolve));
            controller.abort();
          }
        }
      })(),
      /cancelled/u,
    );
    assert.equal(requests, 4);
    assert.ok(
      observations.some(
        (observation) => observation.type === "turn.compaction" && observation.phase === "started",
      ),
    );
    assert.equal(
      observations.some((observation) => observation.type === "turn.completed"),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi agent engine cancellation aborts an unsettled retry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-pi-retry-cancel-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 429 });
  const controller = new AbortController();

  try {
    const observations: PiAgentObservation[] = [];
    await assert.rejects(
      (async () => {
        for await (const observation of new PiAgentEngine(root, async () => ({
          secret: "fixture-secret",
          release: () => undefined,
        })).runTurn(
          {
            taskId: "task-retry-cancel",
            prompt: "cancel while retrying",
            model: "deepseek-v4-flash",
            cwd: process.cwd(),
          },
          controller.signal,
        )) {
          observations.push(observation);
          if (observation.type === "turn.retrying") controller.abort();
        }
      })(),
      /cancelled/u,
    );
    assert.ok(observations.some((observation) => observation.type === "turn.retrying"));
    assert.equal(
      observations.some((observation) => observation.type === "turn.completed"),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi agent engine does not start an already cancelled turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-pi-pre-cancelled-"));
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  let leaseCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 500 });
  };
  const controller = new AbortController();
  controller.abort();

  try {
    await assert.rejects(
      (async () => {
        for await (const _observation of new PiAgentEngine(root, async () => {
          leaseCalls += 1;
          return { secret: "fixture-secret", release: () => undefined };
        }).runTurn(
          {
            taskId: "task-pre-cancelled",
            prompt: "must not start",
            model: "deepseek-v4-flash",
            cwd: process.cwd(),
          },
          controller.signal,
        )) {
          void _observation;
        }
      })(),
      /cancelled/u,
    );
    assert.equal(leaseCalls, 0);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi lifecycle event fixtures preserve retry, compaction, and settled ordering", () => {
  const taskId = "task-lifecycle-fixture";
  const events = [
    {
      type: "compaction_start" as const,
      reason: "overflow" as const,
    },
    {
      type: "compaction_end" as const,
      reason: "overflow" as const,
      result: undefined,
      aborted: false,
      willRetry: true,
    },
    {
      type: "auto_retry_start" as const,
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2_000,
      errorMessage: "redacted provider failure",
    },
    {
      type: "auto_retry_end" as const,
      success: true,
      attempt: 1,
    },
    { type: "agent_settled" as const },
  ];
  assert.deepEqual(
    events.map((event) => projectPiLifecycleObservation(event, taskId)?.type),
    ["turn.compaction", "turn.compaction", "turn.retrying", "turn.retry.completed", "turn.settled"],
  );
  assert.deepEqual(projectPiLifecycleObservation(events[1]!, taskId), {
    type: "turn.compaction",
    taskId,
    phase: "completed",
    reason: "overflow",
    aborted: false,
    willRetry: true,
  });
});

test("Pi agent engine keeps hostile .pi resources outside the Candy session boundary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-restricted-loader-"));
  const outside = await mkdtemp(path.join(tmpdir(), "candy-restricted-loader-outside-"));
  const originalFetch = globalThis.fetch;
  const credentialCanary = "sk-proj-restricted-loader-canary-123456";
  let requestBody = "";
  const fetchInputs: string[] = [];
  const executionMarker = path.join(root, "execution-probe-marker");
  const installMarker = path.join(root, "install-probe-marker");
  globalThis.fetch = async (_input, init) => {
    fetchInputs.push(String(_input));
    requestBody = String(init?.body ?? "");
    return new Response(
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };

  try {
    await mkdir(path.join(root, ".pi", "extensions"), { recursive: true });
    await mkdir(path.join(root, ".pi", "skills", "fixture"), { recursive: true });
    await mkdir(path.join(root, ".pi", "prompts"), { recursive: true });
    await mkdir(path.join(root, ".pi", "themes"), { recursive: true });
    await writeFile(
      path.join(root, "AGENTS.md"),
      `workspace guidance\ntoken: ${credentialCanary}\n`,
    );
    await writeFile(
      path.join(root, ".pi", "settings.json"),
      JSON.stringify({ packages: ["https://invalid.test/install-probe"] }),
    );
    await writeFile(
      path.join(root, ".pi", "extensions", "probe.ts"),
      `import { spawnSync } from "node:child_process";\nspawnSync("sh", ["-c", "printf executed > ${executionMarker}"]);\n`,
    );
    await writeFile(path.join(root, ".pi", "skills", "fixture", "SKILL.md"), "skill probe\n");
    await writeFile(path.join(root, ".pi", "prompts", "probe.md"), "prompt probe\n");
    await writeFile(path.join(root, ".pi", "themes", "probe.json"), "theme probe\n");
    await chmod(path.join(root, ".pi", "extensions", "probe.ts"), 0o700);
    await writeFile(
      path.join(root, ".pi", "install-probe.sh"),
      `#!/bin/sh\nprintf installed > ${installMarker}\n`,
    );
    await chmod(path.join(root, ".pi", "install-probe.sh"), 0o700);
    await writeFile(path.join(outside, "outside.md"), "outside probe\n");
    await symlink(
      outside,
      path.join(root, ".pi", "outside-link"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const observations = [];
    for await (const observation of new PiAgentEngine(root, async () => ({
      secret: credentialCanary,
      release: () => undefined,
    })).runTurn(
      {
        taskId: "task-restricted-loader",
        prompt: "say hello",
        model: "deepseek-v4-flash",
        cwd: root,
      },
      new AbortController().signal,
    )) {
      observations.push(observation);
    }

    assert.ok(observations.some((observation) => observation.type === "turn.completed"));
    assert.doesNotMatch(
      requestBody,
      /\.pi|extension probe|skill probe|prompt probe|theme probe|invalid\.test/u,
    );
    assert.doesNotMatch(requestBody, new RegExp(credentialCanary, "u"));
    assert.match(requestBody, /workspace guidance/u);
    assert.match(requestBody, /\[REDACTED\]/u);
    assert.deepEqual(fetchInputs, ["https://api.deepseek.com/chat/completions"]);
    await assert.rejects(access(executionMarker));
    await assert.rejects(access(installMarker));

    const sessionEntries = await readdir(path.join(root, "task-restricted-loader"));
    const sessionFile = sessionEntries.find((entry) => entry.endsWith(".jsonl"));
    assert.ok(sessionFile);
    const sessionContent = await readFile(
      path.join(root, "task-restricted-loader", sessionFile),
      "utf8",
    );
    assert.doesNotMatch(sessionContent, new RegExp(credentialCanary, "u"));
    assert.doesNotMatch(sessionContent, /extension probe|skill probe|prompt probe|theme probe/u);
    assert.deepEqual((await readdir(path.join(root, ".pi"))).sort(), [
      "extensions",
      "install-probe.sh",
      "outside-link",
      "prompts",
      "settings.json",
      "skills",
      "themes",
    ]);
    assert.equal(await readlink(path.join(root, ".pi", "outside-link")), outside);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Candy restricted resource loader is empty, local-context-only, and fail-closed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-restricted-loader-contract-"));
  const outside = await mkdtemp(path.join(tmpdir(), "candy-restricted-loader-contract-outside-"));
  const credentialCanary = "sk-proj-restricted-loader-contract-canary-123456";
  try {
    const outsideContext = path.join(outside, "AGENTS.md");
    await writeFile(outsideContext, `outside guidance\ntoken: ${credentialCanary}\n`);
    const symlinkLoader = new CandyRestrictedResourceLoader(root, {
      lstat: (filePath) => ({
        size: filePath === path.join(root, "AGENTS.md") ? 128 : 0,
        isFile: () => filePath === path.join(root, "AGENTS.md"),
        isSymbolicLink: () => filePath === path.join(root, "AGENTS.md"),
      }),
      readFile: () => readFileSync(outsideContext),
      realpath: (filePath) => (filePath === root ? root : outsideContext),
    });
    assert.deepEqual(symlinkLoader.getAgentsFiles(), { agentsFiles: [] });

    await rm(path.join(root, "AGENTS.md"), { force: true });
    await writeFile(path.join(root, "AGENTS.md"), `root guidance\ntoken: ${credentialCanary}\n`);
    await mkdir(path.join(root, ".pi", "extensions"), { recursive: true });
    await writeFile(path.join(root, ".pi", "settings.json"), "package probe\n");
    const observedPaths: string[] = [];
    const observedDotPiPaths: string[] = [];
    const dotPiPath = path.resolve(root, ".pi");
    const observePath = (filePath: string): void => {
      const resolvedPath = path.resolve(filePath);
      const relativePath = path.relative(dotPiPath, resolvedPath);
      const isInsideDotPi =
        relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`));
      if (isInsideDotPi) {
        observedDotPiPaths.push(filePath);
      }
      observedPaths.push(filePath);
    };
    const loader = new CandyRestrictedResourceLoader(root, {
      lstat: (filePath) => {
        observePath(filePath);
        return lstatSync(filePath);
      },
      readFile: (filePath) => {
        observePath(filePath);
        return readFileSync(filePath);
      },
      realpath: (filePath) => {
        observePath(filePath);
        return realpathSync(filePath);
      },
    });
    assert.ok(observedPaths.length > 0);
    assert.deepEqual(observedDotPiPaths, []);
    const extensions = loader.getExtensions();
    assert.deepEqual(extensions.extensions, []);
    assert.deepEqual(extensions.errors, []);
    assert.deepEqual(loader.getSkills(), { skills: [], diagnostics: [] });
    assert.deepEqual(loader.getPrompts(), { prompts: [], diagnostics: [] });
    assert.deepEqual(loader.getThemes(), { themes: [], diagnostics: [] });
    assert.match(loader.getSystemPrompt(), /local-first coding agent/u);
    assert.deepEqual(loader.getSystemPromptSource(), { path: "<candy-default>" });
    assert.deepEqual(loader.getAppendSystemPrompt(), []);
    assert.deepEqual(loader.getAppendSystemPromptSources(), []);
    assert.deepEqual(loader.getAgentsFiles(), {
      agentsFiles: [
        {
          path: await realpath(path.join(root, "AGENTS.md")),
          content: "root guidance\ntoken: [REDACTED]\n",
        },
      ],
    });

    await loader.reload();
    assert.throws(() => loader.extendResources({ skillPaths: ["skill-probe"] }), /rejects/u);
    assert.throws(() => loader.extendResources({ promptPaths: ["prompt-probe"] }), /rejects/u);
    assert.throws(() => loader.extendResources({ themePaths: ["theme-probe"] }), /rejects/u);
    loader.extendResources({});
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Candy restricted context loader rejects a resource that changes during the read", () => {
  const root = "/workspace";
  const outside = "/outside/AGENTS.md";
  let swapped = false;
  const loader = new CandyRestrictedResourceLoader(root, {
    lstat: (filePath) => ({
      size: 19,
      isFile: () => !swapped && filePath === path.join(root, "AGENTS.md"),
      isSymbolicLink: () => swapped && filePath === path.join(root, "AGENTS.md"),
    }),
    readFile: () => {
      swapped = true;
      return Buffer.from("workspace guidance\n");
    },
    realpath: (filePath) => {
      if (filePath === root) return root;
      return swapped ? outside : path.join(root, "AGENTS.md");
    },
  });
  assert.deepEqual(loader.getAgentsFiles(), { agentsFiles: [] });
});

test("Candy restricted resource loader exposes only Candy-owned instructions, skills, and prompts", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "candy-resource-workspace-"));
  const candyRoot = await mkdtemp(path.join(tmpdir(), "candy-resource-root-"));
  const credentialCanary = "resource-secret-canary-123456";
  try {
    await mkdir(path.join(candyRoot, "skills", "inspect"), { recursive: true });
    await mkdir(path.join(candyRoot, "prompts"), { recursive: true });
    await writeFile(
      path.join(candyRoot, "SYSTEM.md"),
      `Candy-owned system rules\ntoken: ${credentialCanary}\n`,
    );
    await writeFile(path.join(candyRoot, "APPEND_SYSTEM.md"), "Append only local rules\n");
    await writeFile(
      path.join(candyRoot, "skills", "inspect", "SKILL.md"),
      "---\nname: inspect\ndescription: Inspect bounded evidence\ndisable-model-invocation: true\n---\nInspect $ARGUMENTS\n",
    );
    await writeFile(
      path.join(candyRoot, "prompts", "review.md"),
      "---\nname: review\ndescription: Review a change\nargument-hint: <path>\n---\nReview $1\n",
    );

    const loader = new CandyRestrictedResourceLoader(
      workspace,
      undefined,
      [credentialCanary],
      candyRoot,
    );
    assert.match(loader.getSystemPrompt(), /Candy-owned system rules/u);
    assert.doesNotMatch(loader.getSystemPrompt(), new RegExp(credentialCanary, "u"));
    assert.match(loader.getSystemPrompt(), /\[REDACTED\]/u);
    assert.deepEqual(loader.getAppendSystemPrompt(), ["Append only local rules\n"]);
    assert.equal(loader.getSkills().skills[0]?.name, "inspect");
    assert.equal(loader.getSkills().skills[0]?.disableModelInvocation, true);
    assert.equal(loader.getPrompts().prompts[0]?.name, "review");
    assert.equal(loader.getPrompts().prompts[0]?.argumentHint, "<path>");
    assert.equal(loader.getPrompts().prompts[0]?.content, "Review $1\n");
    const candyRootReal = await realpath(candyRoot);
    assert.ok(loader.getSkills().skills[0]?.filePath.startsWith(candyRootReal));
    assert.ok(loader.getPrompts().prompts[0]?.filePath.startsWith(candyRootReal));
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(candyRoot, { recursive: true, force: true });
  }
});

test("Pi agent sanitizes provider failures before exposing them to Runtime", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-pi-provider-error-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 401 });
  try {
    let caught: unknown;
    try {
      for await (const _observation of new PiAgentEngine(root, async () => ({
        secret: "fixture-secret",
        release: () => undefined,
      })).runTurn(
        {
          taskId: "task-provider-error",
          prompt: "trigger controlled provider error",
          model: "deepseek-v4-flash",
          cwd: process.cwd(),
        },
        new AbortController().signal,
      )) {
        // The provider failure must not become a Runtime observation.
        void _observation;
      }
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof ProviderContractError);
    assert.equal(caught.code, "provider_error");
    assert.equal(caught.reason, "unauthorized");
    assert.doesNotMatch(caught.message, /fixture-secret|401/u);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("Candy workspace operations keep Pi edit/write inside the selected directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-workspace-tools-"));
  const outside = await mkdtemp(path.join(tmpdir(), "candy-workspace-outside-"));
  const operations = createCandyWorkspaceOperations(root);
  try {
    await assert.rejects(operations.readFile("relative.txt"), /absolute/u);
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
    assert.equal(
      (await operations.readFile(path.join(root, "src", "value.ts"))).toString(),
      "export const value = 1;\n",
    );
    await operations.writeFile(path.join(root, "src", "value.ts"), "export const value = 2;\n");
    await operations.mkdir(path.join(root, "generated", "nested"));
    await assert.rejects(
      operations.readFile(path.join(root, "..", path.basename(outside), "secret.txt")),
      /escaped/u,
    );
    await writeFile(path.join(outside, "secret.txt"), "outside\n");
    await symlink(
      outside,
      path.join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      operations.readFile(path.join(root, "linked", "secret.txt")),
      /symbolic/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Candy Bash operations use the fixed Git Bash argv and approved Task Worktree", async () => {
  const calls: unknown[] = [];
  let approvalRequest: unknown;
  const operations = createCandyBashOperations("C:\\task-worktree", {
    bashPath: "C:\\Program Files\\Git\\bin\\bash.exe",
    exists: () => true,
    pathSeam: path.win32,
    activeSecrets: ["fixture-secret"],
    onApproval: async (request) => {
      approvalRequest = request;
      return true;
    },
    runner: {
      run: async (request) => {
        calls.push(request);
        return {
          code: 0,
          signal: null,
          stdout: "fixture-secret output",
          stderr: "",
          cancelled: false,
        };
      },
    },
  });
  const chunks: Buffer[] = [];
  const result = await operations.exec("npm test", "C:\\task-worktree", {
    onData: (chunk) => chunks.push(chunk),
    timeout: 30,
  });
  assert.deepEqual(result, { exitCode: 0 });
  assert.deepEqual(approvalRequest, { command: "npm test", cwd: "C:\\task-worktree", timeout: 30 });
  const request = calls[0] as {
    executable: string;
    args: readonly string[];
    cwd: string;
    workspace: string;
    activeSecrets?: readonly string[];
    environment?: Readonly<Record<string, string>>;
  };
  assert.equal(calls.length, 1);
  assert.deepEqual(
    {
      executable: request.executable,
      args: request.args,
      cwd: request.cwd,
      workspace: request.workspace,
      activeSecrets: request.activeSecrets,
    },
    {
      executable: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: [
        "--noprofile",
        "--norc",
        "-c",
        'trap \'status=$?; trap - EXIT; for pid in $(jobs -pr); do kill "$pid" 2>/dev/null || true; done; exit "$status"\' EXIT\nnpm test',
      ],
      cwd: "C:\\task-worktree",
      workspace: "C:\\task-worktree",
      activeSecrets: ["fixture-secret"],
    },
  );
  assert.equal(Buffer.concat(chunks).toString(), "[REDACTED] output");
  if (process.platform === "darwin" || process.platform === "win32") {
    assert.equal(request.environment?.HOME, "C:\\task-worktree");
    assert.equal(request.environment?.GIT_CONFIG_NOSYSTEM, "1");
  }
  if (process.platform === "win32") {
    assert.equal(request.environment?.USERPROFILE, "C:\\task-worktree");
    assert.equal(request.environment?.GIT_CONFIG_GLOBAL, "NUL");
    assert.equal(request.environment?.Path, undefined);
    assert.ok(request.environment?.PATH?.includes("C:\\Program Files\\Git\\cmd"));
  }
});

test("Candy Trusted Shell runs ordinary commands offline without per-command approval", async () => {
  const calls: unknown[] = [];
  const operations = createCandyBashOperations("C:\\task-worktree", {
    bashPath: "C:\\Program Files\\Git\\bin\\bash.exe",
    exists: () => true,
    pathSeam: path.win32,
    runner: {
      run: async (request) => {
        calls.push(request);
        return { code: 0, signal: null, stdout: "offline", stderr: "", cancelled: false };
      },
    },
  });
  const result = await operations.exec("npm test", "C:\\task-worktree", {
    onData: () => undefined,
  });
  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as { readonly network?: boolean }).network, false);
});

test("Candy network shell tool requests a bounded one-command elevation and passes network only to that run", async () => {
  let approvalRequest: unknown;
  let runnerRequest: unknown;
  const tool = createCandyNetworkToolDefinition("C:\\task-worktree", {
    bashPath: "C:\\Program Files\\Git\\bin\\bash.exe",
    exists: () => true,
    pathSeam: path.win32,
    onApproval: async (request) => {
      approvalRequest = request;
      return true;
    },
    runner: {
      run: async (request) => {
        runnerRequest = request;
        return { code: 7, signal: null, stdout: "network-output", stderr: "", cancelled: false };
      },
    },
  });
  const result = await tool.execute(
    "network-1",
    { command: "git fetch origin", reason: "refresh remote metadata", timeout: 15 } as never,
    new AbortController().signal,
    undefined,
    {} as never,
  );
  assert.deepEqual(approvalRequest, {
    command: "git fetch origin",
    cwd: "C:\\task-worktree",
    reason: "refresh remote metadata",
    timeout: 15,
  });
  assert.equal((runnerRequest as { readonly network?: boolean }).network, true);
  assert.deepEqual(result, {
    content: [{ type: "text", text: "network-output" }],
    details: { exitCode: 7 },
  });
});

test("Candy network shell tool does not spawn when approval is cancelled before launch", async () => {
  const controller = new AbortController();
  let runnerCalled = false;
  const tool = createCandyNetworkToolDefinition("C:\\task-worktree", {
    bashPath: "C:\\Program Files\\Git\\bin\\bash.exe",
    exists: () => true,
    pathSeam: path.win32,
    onApproval: async () => {
      controller.abort();
      return true;
    },
    runner: {
      run: async () => {
        runnerCalled = true;
        throw new Error("runner must not be reached");
      },
    },
  });
  await assert.rejects(
    tool.execute(
      "network-cancelled",
      { command: "git fetch origin", reason: "refresh remote metadata" } as never,
      controller.signal,
      undefined,
      {} as never,
    ),
    /aborted/iu,
  );
  assert.equal(runnerCalled, false);
});

test("Candy Bash operations deny before runner execution and reject cwd escape", async () => {
  let runnerCalled = false;
  const operations = createCandyBashOperations("C:\\task-worktree", {
    bashPath: "C:\\Program Files\\Git\\bin\\bash.exe",
    exists: () => true,
    pathSeam: path.win32,
    onApproval: async () => false,
    runner: {
      run: async () => {
        runnerCalled = true;
        throw new Error("must not run");
      },
    },
  });
  await assert.rejects(
    operations.exec("dir", "C:\\task-worktree", { onData: () => undefined }),
    /denied/iu,
  );
  assert.equal(runnerCalled, false);
  await assert.rejects(
    operations.exec("dir", "C:\\other", { onData: () => undefined }),
    /Task Worktree/iu,
  );
});

test("Candy Bash operations reject credential-shaped commands before approval or spawn", async () => {
  let approved = false;
  let runnerCalled = false;
  const operations = createCandyBashOperations("C:\\task-worktree", {
    bashPath: "C:\\Program Files\\Git\\bin\\bash.exe",
    exists: () => true,
    pathSeam: path.win32,
    onApproval: async () => {
      approved = true;
      return true;
    },
    runner: {
      run: async () => {
        runnerCalled = true;
        throw new Error("must not run");
      },
    },
  });
  await assert.rejects(
    operations.exec("echo Bearer fixture-secret-value-012345", "C:\\task-worktree", {
      onData: () => undefined,
    }),
    /credentials/iu,
  );
  assert.equal(approved, false);
  assert.equal(runnerCalled, false);
});

test("Candy Trusted Shell rejects publication commands before approval or spawn", async () => {
  let approved = false;
  let runnerCalled = false;
  const operations = createCandyBashOperations("C:\\task-worktree", {
    bashPath: "C:\\Program Files\\Git\\bin\\bash.exe",
    exists: () => true,
    pathSeam: path.win32,
    onApproval: async () => {
      approved = true;
      return true;
    },
    runner: {
      run: async () => {
        runnerCalled = true;
        throw new Error("must not run");
      },
    },
  });
  await assert.rejects(
    operations.exec("git -C repo commit -am change", "C:\\task-worktree", {
      onData: () => undefined,
    }),
    /publication/iu,
  );
  assert.equal(approved, false);
  assert.equal(runnerCalled, false);

  approved = false;
  runnerCalled = false;
  await assert.rejects(
    operations.exec("g=git;$g push origin HEAD", "C:\\task-worktree", {
      onData: () => undefined,
    }),
    /publication/iu,
  );
  assert.equal(approved, false);
  assert.equal(runnerCalled, false);

  const network = createCandyNetworkToolDefinition("C:\\task-worktree", {
    bashPath: "C:\\Program Files\\Git\\bin\\bash.exe",
    exists: () => true,
    pathSeam: path.win32,
    onApproval: async () => {
      approved = true;
      return true;
    },
    runner: {
      run: async () => {
        runnerCalled = true;
        throw new Error("must not run");
      },
    },
  });
  approved = false;
  runnerCalled = false;
  await assert.rejects(
    network.execute(
      "network-publish",
      { command: "git push origin HEAD", reason: "publish changes" } as never,
      new AbortController().signal,
      undefined,
      {} as never,
    ),
    /publication/iu,
  );
  assert.equal(approved, false);
  assert.equal(runnerCalled, false);

  await assert.rejects(
    operations.exec("git \\\npush origin HEAD", "C:\\task-worktree", {
      onData: () => undefined,
    }),
    /publication/iu,
  );
  await assert.rejects(
    operations.exec("git -c alias.p=push p origin HEAD", "C:\\task-worktree", {
      onData: () => undefined,
    }),
    /publication/iu,
  );
  await assert.rejects(
    operations.exec("git -C repo p origin HEAD", "C:\\task-worktree", {
      onData: () => undefined,
    }),
    /publication/iu,
  );

  let safeRunnerCalled = false;
  const safeOperations = createCandyBashOperations("C:\\task-worktree", {
    bashPath: "C:\\Program Files\\Git\\bin\\bash.exe",
    exists: () => true,
    pathSeam: path.win32,
    onApproval: async () => true,
    runner: {
      run: async () => {
        safeRunnerCalled = true;
        return { code: 0, signal: null, stdout: "", stderr: "", cancelled: false };
      },
    },
  });
  await safeOperations.exec("git -C repo status --short", "C:\\task-worktree", {
    onData: () => undefined,
  });
  assert.equal(safeRunnerCalled, true);
});

test("Candy Trusted Shell only grants Candy-approved Git metadata paths", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "candy-trusted-shell-worktree-"));
  const common = await mkdtemp(path.join(tmpdir(), "candy-trusted-shell-common-"));
  const commonDirectory = path.join(common, ".git");
  const gitDirectory = path.join(commonDirectory, "worktrees", "task");
  await mkdir(gitDirectory, { recursive: true });
  await writeFile(path.join(workspace, ".git"), `gitdir: ${gitDirectory}\n`);
  await writeFile(path.join(gitDirectory, "commondir"), "../..\n");
  let readOnlyPaths: readonly string[] | undefined;
  let runnerCalled = false;
  const operations = createCandyBashOperations(workspace, {
    bashPath: "/bin/bash",
    exists: () => true,
    trustedGitCommonDirectory: commonDirectory,
    runner: {
      run: async (request) => {
        runnerCalled = true;
        readOnlyPaths = request.readOnlyPaths;
        return { code: 0, signal: null, stdout: "", stderr: "", cancelled: false };
      },
    },
  });
  await operations.exec("git status --short", workspace, { onData: () => undefined });
  assert.equal(runnerCalled, true);
  assert.deepEqual(readOnlyPaths, [
    path.join(workspace, ".git"),
    await realpath(gitDirectory),
    await realpath(commonDirectory),
  ]);

  await writeFile(path.join(workspace, ".git"), `gitdir: ${path.dirname(common)}\n`);
  runnerCalled = false;
  await assert.rejects(
    operations.exec("git status --short", workspace, { onData: () => undefined }),
    /outside Candy's approved repository/iu,
  );
  assert.equal(runnerCalled, false);
});

test("Candy Bash operations abort the native runner on timeout", async () => {
  let runnerSignal: AbortSignal | undefined;
  const operations = createCandyBashOperations("C:\\task-worktree", {
    bashPath: "C:\\Program Files\\Git\\bin\\bash.exe",
    exists: () => true,
    pathSeam: path.win32,
    onApproval: async () => true,
    runner: {
      run: async (request) => {
        runnerSignal = request.signal;
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { code: null, signal: null, stdout: "", stderr: "", cancelled: true };
      },
    },
  });
  await assert.rejects(
    operations.exec("timeout-test", "C:\\task-worktree", {
      onData: () => undefined,
      timeout: 0.01,
    }),
    /timeout:0\.01/iu,
  );
  assert.equal(runnerSignal?.aborted, true);
});

test("Candy Bash operations propagate task cancellation to the native runner", async () => {
  const taskAbort = new AbortController();
  let runnerSignal: AbortSignal | undefined;
  const operations = createCandyBashOperations("C:\\task-worktree", {
    bashPath: "C:\\Program Files\\Git\\bin\\bash.exe",
    exists: () => true,
    pathSeam: path.win32,
    onApproval: async () => true,
    runner: {
      run: async (request) => {
        runnerSignal = request.signal;
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { code: null, signal: null, stdout: "", stderr: "", cancelled: true };
      },
    },
  });
  const execution = operations.exec("cancel-test", "C:\\task-worktree", {
    onData: () => undefined,
    signal: taskAbort.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  taskAbort.abort();
  await assert.rejects(execution, /aborted/iu);
  assert.equal(runnerSignal?.aborted, true);
});

test("MiniMax Pi engine sends image turns through the domestic M3 provider", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-pi-minimax-"));
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"fixture","type":"message","role":"assistant","model":"MiniMax-M3","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"vision"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const observations = [];
    for await (const observation of new MiniMaxPiAgentEngine(root, async () => ({
      secret: "fixture-secret",
      release: () => undefined,
    })).runTurn(
      {
        taskId: "task-vision",
        prompt: "describe the image",
        model: "MiniMax-M3",
        cwd: process.cwd(),
        images: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
      },
      new AbortController().signal,
    )) {
      observations.push(observation);
    }
    assert.equal(requestUrl, "https://api.minimaxi.com/anthropic/v1/messages");
    const message = (requestBody?.messages as { content?: unknown }[] | undefined)?.[0];
    assert.deepEqual(message?.content, [
      { type: "text", text: "describe the image" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
        cache_control: { type: "ephemeral" },
      },
    ]);
    assert.ok(observations.some((observation) => observation.type === "assistant.delta"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DeepSeek image turns fail closed without silently falling back to MiniMax", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-pi-deepseek-image-reject-"));
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 500 });
  };
  try {
    const engine = new PiAgentEngine(root, async () => ({
      secret: "fixture-secret",
      release: () => undefined,
    }));
    await assert.rejects(
      (async () => {
        for await (const _observation of engine.runTurn(
          {
            taskId: "task-deepseek-image",
            prompt: "describe",
            model: "deepseek-v4-flash",
            cwd: root,
            images: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
          },
          new AbortController().signal,
        )) {
          void _observation;
        }
      })(),
      /switch to MiniMax M3/u,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi session manager persists in Candy-owned storage and reloads with a remapped cwd", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-pi-session-"));
  const store = new CandyPiSessionStore(root);
  const created = await store.create("task-1", "C:/fixture/project");
  const reloaded = await store.reload(created, "/Users/test/project");
  assert.equal(reloaded.sessionFile, created.sessionFile);
  assert.equal(reloaded.sessionId, created.sessionId);
  assert.equal(reloaded.cwd, "/Users/test/project");
  const content = await readFile(created.sessionFile, "utf8");
  assert.ok(CandyPiSessionStore.fingerprint(content).length > 0);
});
