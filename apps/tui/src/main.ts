import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type FileDeleteApprovalRequest,
  PI_COMPATIBILITY_VERSION,
  MiniMaxPiAgentEngine,
  PiAgentEngine,
  ProviderContractError,
  type CandyNetworkApprovalRequest,
  type CandyPromptTemplateInfo,
  loadCandyResourceDiagnostics,
  loadCandyPromptTemplates,
  type PiAgentEngineInput,
  type PiAgentObservation,
  listPiPublicExports,
} from "@candy/pi-adapter";
import {
  type CandyModelId,
  containsCredentialMaterial,
  type CredentialName,
  type CredentialStore,
  CANDY_CREDENTIAL_ENV_KEYS,
  DEFAULT_CANDY_MODEL,
  KeyringCredentialStore,
  NativeProcessRunner,
  type NativeProcessRequest,
  type NativeProcessResult,
  resolveAppPaths,
  resolveCredential,
  resolveDefaultAppDataRoot,
  resolveNativeProcessRunnerPath,
  redactCredentialMaterial,
  SQLiteTaskStore,
  SystemClock,
  type TaskMetadata,
  type TaskReviewMetadata,
  discoverGitBashExecutable,
  getWindowsTrustedShellCapabilityStatus,
  isTrustedShellAutoAvailable as isPlatformTrustedShellAutoAvailable,
} from "@candy/platform";
import {
  ApplyChangesBlockedError,
  ApplyChangesService,
  AttachmentStore,
  CommandValidator,
  CandyRuntime,
  DeterministicAgentEngine,
  GitWorktreeManager,
  GitWorkspaceChangeTracker,
  NonGitWorkspaceChangeTracker,
  ResolvedWorkspaceChangeTracker,
  MAX_ATTACHMENT_BYTES,
  MAX_UNTRACKED_FILE_BYTES,
  TaskController,
  TaskScheduler,
  UnavailableBrowserCapability,
  type CommandValidatorCommand,
  type GitWorktreePlan,
  type ValidatorResult,
  type WorkspaceChangeSnapshot,
  type WorkspaceChangeTracker,
  planGitWorktree,
  resolveGitCommonDirectory,
} from "@candy/runtime";
import { CandyTuiSurface, type CandyTuiTerminal } from "./pi-tui-surface.js";

export interface TuiSmokeResult {
  readonly piVersion: string;
  readonly piRootExportCount: number;
  readonly browserAvailable: boolean;
  readonly observationTypes: readonly string[];
}

export interface TuiTaskSmokeResult {
  readonly taskId: string;
  readonly state: string;
  readonly revision: number;
  readonly queued: readonly string[];
  readonly observations: readonly string[];
}

const activeTuiOwners = new Set<string>();
const NO_FOLLOW_FINAL_PATH = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;

export async function runTuiSmoke(): Promise<TuiSmokeResult> {
  const browser = new UnavailableBrowserCapability();
  const runtime = new CandyRuntime(
    new DeterministicAgentEngine(new SystemClock(), "fixture response"),
    browser,
  );
  const observations = await runtime.runReadOnlyTurn(
    { taskId: "smoke-task", prompt: "inspect the fixture" },
    new AbortController().signal,
  );

  return {
    piVersion: PI_COMPATIBILITY_VERSION,
    piRootExportCount: listPiPublicExports().length,
    browserAvailable: browser.available,
    observationTypes: observations.map((observation) => observation.type),
  };
}

export async function runTuiTaskSmoke(): Promise<TuiTaskSmokeResult> {
  const task = new TaskController("tui-task-smoke", "read-only");
  const scheduler = new TaskScheduler();
  scheduler.enqueue("tui-task-smoke");
  scheduler.startAvailable();
  task.setOwner("tui-smoke-owner", 0);
  const runtime = new CandyRuntime(
    new DeterministicAgentEngine(new SystemClock(), "read-only response"),
    new UnavailableBrowserCapability(),
  );
  const observations = await runtime.runReadOnlyTurn(
    { taskId: "tui-task-smoke", prompt: "inspect the fixture" },
    new AbortController().signal,
  );
  const completed = task.transition("completed", 1);
  scheduler.finish("tui-task-smoke");
  return {
    taskId: completed.taskId,
    state: completed.state,
    revision: completed.revision,
    queued: scheduler.queued(),
    observations: observations.map((observation) => observation.type),
  };
}

export interface InteractiveTuiOptions {
  readonly appDataRoot?: string;
  readonly workspacePath?: string;
  readonly engine?: TuiAgentEngine;
  readonly attachmentStore?: AttachmentStore;
  readonly terminal?: CandyTuiTerminal;
  readonly changeTracker?: WorkspaceChangeTracker;
  readonly validator?: TuiValidator;
  readonly validatorCommand?: CommandValidatorCommand;
  readonly validatorTimeoutMs?: number;
  readonly activeSecrets?: () => readonly string[];
  readonly credentialStore?: CredentialStore;
  readonly credentialEnvironment?: NodeJS.ProcessEnv;
  readonly shellRunner?: TuiShellRunner;
  /** Set only by a composition root after the platform-specific G2 gate passes. */
  readonly trustedShellAutoAvailable?: boolean;
}

const MACOS_TRUSTED_SHELL_AUTO_G2_ATTESTATION = Object.freeze({
  // macOS G2 approved by the product owner on 2026-08-19 after the
  // independent review package at docs/implementation/macos-g2-review-3408413.md
  // and the security hardening checkpoints 9009ac1/3408413. The gate remains
  // host/architecture-bound; environment variables cannot enable it.
  approved: true,
  platform: "darwin",
  architecture: "arm64",
  nativeBackend: "seatbelt-v1",
} as const);

/**
 * The accepted macOS Trusted Shell Auto Personal Preview composition-root
 * gate. The immutable source attestation is combined with the host platform
 * and architecture; user-controlled environment variables must not be able
 * to enable it.
 */
export function isMacosTrustedShellAutoAvailable(): boolean {
  return (
    MACOS_TRUSTED_SHELL_AUTO_G2_ATTESTATION.approved &&
    process.platform === MACOS_TRUSTED_SHELL_AUTO_G2_ATTESTATION.platform &&
    process.arch === MACOS_TRUSTED_SHELL_AUTO_G2_ATTESTATION.architecture
  );
}

function isTrustedShellAutoAvailableOnHost(): boolean {
  return isPlatformTrustedShellAutoAvailable() || isMacosTrustedShellAutoAvailable();
}

export type TuiCompositionRootOptions = Omit<InteractiveTuiOptions, "trustedShellAutoAvailable">;

/**
 * Normal TUI composition root. The capability is injected only here after
 * the accepted macOS G2 attestation; InteractiveTui itself remains safe by
 * default for tests and non-TUI embedders.
 */
export function createDefaultInteractiveTui(
  options: TuiCompositionRootOptions = {},
): InteractiveTui {
  return new InteractiveTui({
    ...options,
    trustedShellAutoAvailable: isTrustedShellAutoAvailableOnHost(),
  });
}

export interface TuiShellRunner {
  readonly bashPath?: string;
  run(request: NativeProcessRequest): Promise<NativeProcessResult>;
}

export interface TuiAgentEngine {
  runTurn(input: PiAgentEngineInput, signal: AbortSignal): AsyncIterable<PiAgentObservation>;
  steer?(taskId: string, text: string): Promise<void>;
  followUp?(taskId: string, text: string): Promise<void>;
  /** Retained for compatibility with embedders; TUI recovery never calls it. */
  recoverPrompt?(taskId: string, cwd: string): Promise<string | undefined>;
}

export interface TuiValidator {
  run(
    command: CommandValidatorCommand,
    workspace: string,
    signal: AbortSignal,
    activeSecrets: readonly string[],
  ): Promise<ValidatorResult>;
}

type TuiValidatorStatus =
  "configured" | "running" | "pass" | "fail" | "cancelled" | "timeout" | "blocked";

interface TuiValidatorState {
  readonly status: Exclude<TuiValidatorStatus, "configured">;
  readonly evidence?: string;
  readonly durationMs?: number;
}

type TuiWorkspaceReview = TaskReviewMetadata;

interface TuiCompleteDiff {
  readonly changes: WorkspaceChangeSnapshot;
  readonly text: string;
  readonly untrackedFingerprint: string;
  readonly complete: boolean;
}

const MAX_TUI_DIFF_BYTES = 64 * 1024;
const MAX_TUI_TRANSCRIPT_BYTES = 64 * 1024;
const MAX_TUI_TURN_MESSAGE_CHARS = 4_096;
const DEFAULT_VALIDATOR_TIMEOUT_MS = 30_000;

export class InteractiveTui {
  readonly #appDataRoot: string;
  #workspacePath: string;
  readonly #terminal: CandyTuiTerminal | undefined;
  readonly #store: SQLiteTaskStore;
  readonly #attachments: AttachmentStore;
  readonly #worktreeRoot: string;
  readonly #worktreeManager: GitWorktreeManager;
  readonly #scheduler: TaskScheduler;
  readonly #changeTracker: WorkspaceChangeTracker;
  readonly #validator: TuiValidator | undefined;
  readonly #validatorTimeoutMs: number;
  readonly #activeSecretsProvider: (() => readonly string[]) | undefined;
  readonly #credentialStore: CredentialStore;
  readonly #credentialEnvironment: NodeJS.ProcessEnv;
  readonly #shellRunner: TuiShellRunner | undefined;
  readonly #trustedShellAutoAvailable: boolean;
  readonly #controllers = new Map<string, TaskController>();
  readonly #abortControllers = new Map<string, AbortController>();
  readonly #taskRuns = new Map<string, Promise<void>>();
  readonly #validatorAbortControllers = new Map<string, AbortController>();
  readonly #validatorRuns = new Map<string, Promise<void>>();
  readonly #ownerWatchers = new Map<string, ReturnType<typeof setInterval>>();
  readonly #validatorStops = new Map<string, "cancelled" | "timeout">();
  readonly #validatorStates = new Map<string, TuiValidatorState>();
  readonly #workspaceReviews = new Map<string, TuiWorkspaceReview>();
  readonly #requestedStops = new Map<string, "paused" | "cancelled" | "interrupted">();
  readonly #deleteApprovals = new Map<
    string,
    { readonly taskId: string; readonly settle: (approved: boolean) => void }
  >();
  readonly #networkApprovals = new Map<
    string,
    { readonly taskId: string; readonly settle: (approved: boolean) => void }
  >();
  readonly #engine: TuiAgentEngine;
  readonly #ownerId = `tui:${process.pid}:${randomUUID()}`;
  #currentTaskId: string | undefined;
  #surface: CandyTuiSurface | undefined = undefined;
  #resolveExit: (() => void) | undefined = undefined;
  #closing = false;
  #creatingTask = false;
  #pendingTaskCreation: Promise<void> | undefined;
  #approvalProfile: "read-only" | "auto" = "read-only";
  #selectedModel: CandyModelId = DEFAULT_CANDY_MODEL;
  #selectedAttachmentIds: string[] = [];
  #trustedShellEnabled = false;
  #validatorCommand: CommandValidatorCommand | undefined;

  public constructor(options: InteractiveTuiOptions = {}) {
    this.#appDataRoot = options.appDataRoot ?? resolveDefaultAppDataRoot();
    this.#workspacePath = path.resolve(options.workspacePath ?? process.cwd());
    if (pathsOverlap(this.#workspacePath, this.#appDataRoot))
      throw new Error("The selected workspace cannot overlap Candy application data.");
    this.#terminal = options.terminal;
    const paths = resolveAppPaths(this.#appDataRoot);
    this.#store = new SQLiteTaskStore(path.join(paths.state, "tasks.sqlite"));
    this.#activeSecretsProvider = options.activeSecrets;
    this.#credentialStore = options.credentialStore ?? new KeyringCredentialStore();
    this.#credentialEnvironment = options.credentialEnvironment ?? process.env;
    this.#attachments =
      options.attachmentStore ??
      new AttachmentStore(paths.attachments, Date.now, (content) =>
        containsAnyActiveSecret(content, this.activeSecretsSnapshot()),
      );
    this.#worktreeRoot = paths.worktrees;
    this.#worktreeManager = new GitWorktreeManager(this.#worktreeRoot);
    this.#changeTracker =
      options.changeTracker ??
      new ResolvedWorkspaceChangeTracker(
        new GitWorkspaceChangeTracker(),
        new NonGitWorkspaceChangeTracker(),
      );
    this.#validator = options.validator ?? createNativeTuiValidator();
    this.#validatorTimeoutMs = options.validatorTimeoutMs ?? DEFAULT_VALIDATOR_TIMEOUT_MS;
    this.#shellRunner = options.shellRunner ?? createNativeTuiShellRunner();
    this.#trustedShellAutoAvailable = options.trustedShellAutoAvailable ?? false;
    this.#validatorCommand = options.validatorCommand;
    this.recoverStaleTuiOwners();
    activeTuiOwners.add(this.#ownerId);
    for (const metadata of this.#store.list()) {
      this.#controllers.set(
        metadata.taskId,
        new TaskController(metadata.taskId, metadata.approvalProfile, this.#store),
      );
    }
    this.#scheduler = new TaskScheduler(3, 5, this.#store);
    if (options.engine !== undefined) {
      this.#engine = options.engine;
    } else {
      const deepseek = new PiAgentEngine(
        paths.sessions,
        async () => {
          const lease = resolveCredential(
            "deepseek",
            this.#credentialEnvironment,
            this.#credentialStore,
          );
          return lease ? { secret: lease.value, release: lease.release } : undefined;
        },
        "deepseek",
        this.#shellRunner,
      );
      const minimax = new MiniMaxPiAgentEngine(
        paths.sessions,
        async () => {
          const lease = resolveCredential(
            "minimax-cn",
            this.#credentialEnvironment,
            this.#credentialStore,
          );
          return lease ? { secret: lease.value, release: lease.release } : undefined;
        },
        this.#shellRunner,
      );
      this.#engine = new TuiModelRouter(deepseek, minimax);
    }
  }

  public async run(): Promise<void> {
    this.#surface = new CandyTuiSurface({
      appDataRoot: this.#appDataRoot,
      terminal: this.#terminal,
      onSubmit: (text: string): void => {
        try {
          this.handleInput(text);
        } catch (error) {
          this.write(`input rejected: ${safeError(error)}\n`);
        }
      },
      onInterrupt: (): void => this.requestExit(),
    });
    this.write(
      [
        "Candy TUI — local-first, one agent per task",
        "",
        "Start       type a prompt, or :new [prompt]",
        "Workspace   :workspace <path> · :use <task-id> · :tasks",
        "Provider    :model deepseek-flash|deepseek-pro|minimax-m3",
        "            :credentials set|replace|delete <deepseek|minimax-cn>",
        "Attach      :attach <path> · :attachments",
        "Review      :changes · :diff [path] · :apply · :discard · :validate",
        "Control     :steer <text> · :follow-up <text> · :cancel <task-id>",
        "            :pause/:resume <task-id> <text> · :prioritize <task-id>",
        "Personal    :prompts · :prompt <name> [args] · :resources · :transcript [task-id]",
        "Modes       :profile read-only|auto · :trusted-shell on|off",
        "            :validator <absolute-executable> [args]",
        "Quit        :quit",
        "",
      ].join("\n") + "\n",
    );
    this.write("Profile: read-only · Trusted Shell Auto: off\n");
    const exitPromise: Promise<void> = new Promise<void>((resolve: () => void): void => {
      this.#resolveExit = resolve;
    });
    try {
      this.#surface.start();
      await exitPromise;
    } finally {
      this.#closing = true;
      for (const task of this.#controllers.values()) {
        const current = task.snapshot();
        if (
          (current.state === "running" || current.state === "waiting_approval") &&
          current.ownerId === this.#ownerId
        )
          this.#requestedStops.set(current.taskId, "interrupted");
      }
      for (const approval of this.#deleteApprovals.values()) approval.settle(false);
      for (const approval of this.#networkApprovals.values()) approval.settle(false);
      for (const controller of this.#abortControllers.values()) controller.abort();
      for (const controller of this.#validatorAbortControllers.values()) controller.abort();
      await this.#pendingTaskCreation?.catch(() => undefined);
      await Promise.allSettled([...this.#taskRuns.values(), ...this.#validatorRuns.values()]);
      this.#store.markOwnerInterrupted(this.#ownerId);
      this.#resolveExit = undefined;
      await this.#surface.stop();
      this.#surface = undefined;
      activeTuiOwners.delete(this.#ownerId);
      this.#store.close();
    }
  }

  private handleInput(value: string): void {
    const trimmed: string = value.trim();
    if (trimmed === ":quit") {
      this.requestExit();
    } else if (this.#creatingTask) {
      this.write("task creation in progress; wait for the Task Worktree or queued-task result\n");
    } else if (trimmed === ":new" || trimmed.startsWith(":new ")) {
      this.newTask(trimmed.slice(4).trim());
    } else if (trimmed.startsWith(":use ")) {
      this.useTask(trimmed.slice(5).trim());
    } else if (trimmed === ":workspace" || trimmed.startsWith(":workspace ")) {
      void this.configureWorkspace(trimmed.slice(10).trim()).catch((error: unknown) => {
        this.write(`workspace rejected: ${safeError(error)}\n`);
      });
    } else if (trimmed === ":transcript" || trimmed.startsWith(":transcript ")) {
      this.showTranscript(trimmed.slice(11).trim());
    } else if (trimmed === ":resources") {
      this.showResourceDiagnostics();
    } else if (trimmed === ":prompts") {
      this.listPromptTemplates();
    } else if (trimmed === ":prompt" || trimmed.startsWith(":prompt ")) {
      this.invokePromptTemplate(trimmed.slice(7).trim());
    } else if (trimmed === ":credentials" || trimmed === ":credential") {
      this.showCredentials();
    } else if (trimmed.startsWith(":credential ")) {
      this.configureCredential(trimmed.slice(12).trim());
    } else if (trimmed === ":model" || trimmed.startsWith(":model ")) {
      this.configureModel(trimmed.slice(6).trim());
    } else if (trimmed === ":attach" || trimmed.startsWith(":attach ")) {
      void this.attachPath(trimmed.slice(7).trim()).catch((error: unknown) => {
        this.write(`attachment rejected: ${safeError(error)}\n`);
      });
    } else if (trimmed === ":attachments") {
      void this.showAttachments().catch((error: unknown) => {
        this.write(`attachments unavailable: ${safeError(error)}\n`);
      });
    } else if (trimmed === ":tasks") {
      this.printTasks();
    } else if (trimmed.startsWith(":profile ")) {
      this.setProfile(trimmed.slice(9).trim());
    } else if (trimmed === ":trusted-shell" || trimmed.startsWith(":trusted-shell ")) {
      this.setTrustedShell(trimmed.slice(14).trim());
    } else if (trimmed === ":shell" || trimmed.startsWith(":shell ")) {
      this.setTrustedShell(trimmed.slice(6).trim());
    } else if (trimmed === ":validator" || trimmed.startsWith(":validator ")) {
      this.configureValidator(trimmed.slice(10).trim());
    } else if (trimmed === ":changes") {
      void this.showChanges().catch((error: unknown) => {
        this.write(`changes rejected: ${safeError(error)}\n`);
      });
    } else if (trimmed === ":diff" || trimmed.startsWith(":diff ")) {
      void this.showDiff(trimmed.slice(5).trim()).catch((error: unknown) => {
        this.write(`diff rejected: ${safeError(error)}\n`);
      });
    } else if (trimmed === ":apply") {
      void this.applyCurrent().catch((error: unknown) => {
        this.write(`apply blocked: ${safeError(error)}\n`);
      });
    } else if (trimmed === ":discard") {
      void this.discardCurrent().catch((error: unknown) => {
        this.write(`discard blocked: ${safeError(error)}\n`);
      });
    } else if (trimmed === ":validate") {
      this.validateCurrent();
    } else if (trimmed.startsWith(":approve ")) {
      this.resolveDeleteApproval(trimmed.slice(9).trim(), true);
    } else if (trimmed.startsWith(":deny ")) {
      this.resolveDeleteApproval(trimmed.slice(6).trim(), false);
    } else if (trimmed.startsWith(":prioritize ")) {
      this.prioritize(trimmed.slice(12).trim());
    } else if (trimmed.startsWith(":pause ")) {
      this.pause(trimmed.slice(7).trim());
    } else if (trimmed.startsWith(":resume ")) {
      const resumeValue = trimmed.slice(8).trim();
      const separator = resumeValue.indexOf(" ");
      this.resume(
        separator < 0 ? resumeValue : resumeValue.slice(0, separator),
        separator < 0 ? undefined : resumeValue.slice(separator + 1).trim(),
      );
    } else if (trimmed.startsWith(":steer ")) {
      void this.queueActiveTurnMessage("steer", trimmed.slice(7).trim());
    } else if (trimmed.startsWith(":follow-up ")) {
      void this.queueActiveTurnMessage("followUp", trimmed.slice(11).trim());
    } else if (trimmed.startsWith(":cancel ")) {
      void this.cancel(trimmed.slice(8).trim()).catch((error: unknown) => {
        this.write(`cancel rejected: ${safeError(error)}\n`);
      });
    } else if (trimmed.length > 0) {
      this.submitPrompt(trimmed);
    }
  }

  private requestExit(): void {
    this.#resolveExit?.();
  }

  private create(prompt: string): void {
    if (this.#creatingTask) {
      this.write("task creation in progress; wait for the Task Worktree or queued-task result\n");
      return;
    }
    this.#creatingTask = true;
    const operation = this.createTask(prompt);
    this.#pendingTaskCreation = operation;
    void operation
      .catch((error: unknown) => {
        this.write(`task creation rejected: ${safeError(error)}\n`);
      })
      .finally(() => {
        if (this.#pendingTaskCreation === operation) this.#pendingTaskCreation = undefined;
        this.#creatingTask = false;
      });
  }

  private async createTask(prompt: string): Promise<void> {
    if (containsCredentialMaterial(prompt) || this.hasActiveProviderSecret(prompt)) {
      this.write("prompt rejected: credential-shaped content is forbidden\n");
      return;
    }
    if (this.#selectedAttachmentIds.length > 0 && this.#selectedModel !== "MiniMax-M3") {
      this.write(
        "image attachments require explicit :model minimax-m3; switch models before creating the task\n",
      );
      return;
    }
    const taskId = `task-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const queueOrder =
      this.#store.queued().reduce((max, task) => Math.max(max, task.queueOrder ?? 0), 0) + 1;
    const workspacePath = this.#workspacePath;
    const approvalProfile = this.#approvalProfile;
    const selectedModel = this.#selectedModel;
    const attachmentIds = [...this.#selectedAttachmentIds];
    const validatorCommand = this.#validatorCommand;
    const trustedShell = this.#trustedShellEnabled;
    this.write(`preparing ${taskId} in ${workspacePath}\n`);
    const workspaceBaseline = await this.#changeTracker.captureBaseline(workspacePath);
    if (trustedShell) {
      if (!this.#trustedShellAutoAvailable || !isTrustedShellAutoAvailableOnHost())
        throw new Error("macOS Trusted Shell Auto is unavailable on this platform.");
      if (approvalProfile !== "auto")
        throw new Error("Trusted Shell Auto requires the Auto approval profile.");
      if (this.#shellRunner === undefined)
        throw new Error("Trusted Shell Auto is unavailable on this installation.");
      if (workspaceBaseline === undefined)
        throw new Error("Trusted Shell Auto requires a Git-backed Task Worktree.");
    }
    let worktreePath: string | undefined;
    if (approvalProfile === "auto" && workspaceBaseline !== undefined) {
      const plan = this.planForTask(taskId, workspacePath, workspaceBaseline);
      try {
        await this.#worktreeManager.create(plan);
      } catch (error) {
        throw new Error("Task Worktree creation failed.", { cause: error });
      }
      worktreePath = plan.worktreePath;
    }
    let metadata: TaskMetadata;
    try {
      metadata = this.#store.create(
        taskId,
        approvalProfile,
        queueOrder,
        selectedModel,
        attachmentIds,
        workspacePath,
        validatorCommand,
        workspaceBaseline,
        worktreePath,
        trustedShell,
      );
    } catch (error) {
      if (worktreePath !== undefined) {
        try {
          await this.#worktreeManager.discard(
            this.planForTask(taskId, workspacePath, workspaceBaseline!),
          );
        } catch {
          throw new Error("Task metadata creation and Task Worktree cleanup failed.", {
            cause: error,
          });
        }
      }
      throw error;
    }
    this.#selectedAttachmentIds = [];
    const controller = new TaskController(taskId, approvalProfile, this.#store);
    this.#controllers.set(taskId, controller);
    this.#currentTaskId = taskId;
    this.#scheduler.enqueue(taskId);
    this.write(`created ${taskId} (${metadata.state})\n`);
    if (worktreePath !== undefined) this.write(`Task Worktree: ${worktreePath}\n`);
    if (trustedShell) {
      this.#trustedShellEnabled = false;
      this.write(
        "Trusted Shell Auto enabled for this task: offline commands run automatically; network requires one-command approval\n",
      );
    }
    if (!this.#closing) this.drain(new Map([[taskId, prompt]]));
  }

  private drain(explicitPrompts: ReadonlyMap<string, string> = new Map()): void {
    for (const taskId of this.#scheduler.startAvailable()) {
      if (this.#abortControllers.has(taskId)) continue;
      const task = this.ensureController(taskId);
      if (!task || !["queued", "paused", "interrupted"].includes(task.snapshot().state)) continue;
      task.setOwner(this.#ownerId, task.snapshot().revision);
      const abort = new AbortController();
      this.#abortControllers.set(taskId, abort);
      this.startOwnerWatch(taskId, abort);
      const operation = this.runTask(task, abort, explicitPrompts.get(taskId));
      this.#taskRuns.set(taskId, operation);
      void operation
        .catch((error: unknown) => {
          if (!this.#closing) this.write(`task ${taskId} failed: ${safeError(error)}\n`);
        })
        .finally(() => {
          if (this.#taskRuns.get(taskId) === operation) this.#taskRuns.delete(taskId);
        });
    }
  }

  private ensureController(taskId: string): TaskController | undefined {
    const metadata = this.#store.get(taskId);
    if (!metadata) return undefined;
    const existing = this.#controllers.get(taskId);
    if (existing?.snapshot().revision === metadata.revision) return existing;
    const controller = new TaskController(taskId, metadata.approvalProfile, this.#store);
    this.#controllers.set(taskId, controller);
    return controller;
  }

  private submitPrompt(prompt: string): void {
    if (containsCredentialMaterial(prompt) || this.hasActiveProviderSecret(prompt)) {
      this.write("prompt rejected: credential material is forbidden\n");
      return;
    }
    const currentTaskId = this.#currentTaskId;
    if (currentTaskId === undefined) {
      this.create(prompt);
      return;
    }
    const task = this.ensureController(currentTaskId);
    if (!task) {
      this.write(`current task ${currentTaskId} is unavailable; use :new\n`);
      return;
    }
    const snapshot = task.snapshot();
    if (snapshot.state === "running" || snapshot.state === "waiting_approval") {
      if (snapshot.ownerId !== undefined && snapshot.ownerId !== this.#ownerId) {
        this.write(`task ${currentTaskId} is read-only: owned by ${snapshot.ownerId}\n`);
      } else {
        this.write(
          `task ${currentTaskId} is already running; use :steer <text>, :follow-up <text>, or :cancel ${currentTaskId}\n`,
        );
      }
      return;
    }
    if (snapshot.state === "queued") {
      this.write(`task ${currentTaskId} is queued; cannot add a prompt to its active turn\n`);
      return;
    }
    if (snapshot.state === "cancelled") {
      this.write(`task ${currentTaskId} is cancelled; use :new to create another task\n`);
      return;
    }
    task.queueForContinuation(snapshot.revision);
    this.#scheduler.enqueue(currentTaskId);
    this.write(`continuing ${currentTaskId}\n`);
    this.drain(new Map([[currentTaskId, prompt]]));
  }

  private newTask(prompt: string): void {
    this.#currentTaskId = undefined;
    if (prompt.length === 0) {
      this.write("new task ready; enter a prompt\n");
      return;
    }
    this.create(prompt);
  }

  private async configureWorkspace(value: string): Promise<void> {
    if (value === "") {
      this.write(`workspace: ${this.#workspacePath}\n`);
      return;
    }
    if (containsControlCharacter(value) || !path.isAbsolute(value)) {
      throw new Error("Workspace paths must be absolute and free of control characters.");
    }
    const candidate = path.resolve(value);
    const workspace = await stat(candidate).catch(() => undefined);
    if (workspace === undefined || !workspace.isDirectory()) {
      throw new Error("Workspace path must be an existing directory.");
    }
    const canonicalWorkspace = await realpath(candidate);
    const canonicalAppData = await realpath(this.#appDataRoot).catch(() => this.#appDataRoot);
    if (pathsOverlap(canonicalWorkspace, canonicalAppData))
      throw new Error("The selected workspace cannot overlap Candy application data.");
    this.#workspacePath = canonicalWorkspace;
    this.write(`workspace selected: ${this.#workspacePath}\n`);
  }

  private showCredentials(): void {
    const lines = (["deepseek", "minimax-cn"] as const).map((name) => {
      try {
        return `${name}: ${this.#credentialStore.has(name)}`;
      } catch {
        return `${name}: unavailable`;
      }
    });
    this.write(`credentials (OS store presence only)\n${lines.join("\n")}\n`);
  }

  private configureCredential(value: string): void {
    const [action, requestedName, ...extra] = value.split(/\s+/u).filter((part) => part.length > 0);
    if (extra.length > 0) {
      this.write(
        "credential rejected: provide no credential value; use the Candy-owned temporary environment\n",
      );
      return;
    }
    const name = parseCredentialName(requestedName);
    if ((action !== "set" && action !== "replace" && action !== "delete") || name === undefined) {
      this.write("credential usage: :credential set|replace|delete <deepseek|minimax-cn>\n");
      return;
    }
    try {
      if (action === "delete") {
        this.#credentialStore.delete(name);
        this.write(`${name} credential deleted\n`);
        return;
      }
      const environmentName = CANDY_CREDENTIAL_ENV_KEYS[name];
      const temporary = this.#credentialEnvironment[environmentName];
      if (temporary === undefined) {
        this.write(`${name} credential unavailable: set ${environmentName} for this operation\n`);
        return;
      }
      if (action === "set") this.#credentialStore.set(name, temporary);
      else this.#credentialStore.replace(name, temporary);
      this.write(`${name} credential ${action} (present)\n`);
    } catch (error) {
      this.write(`${name} credential operation rejected: ${credentialStoreError(error)}\n`);
    }
  }

  private configureModel(value: string): void {
    const current = this.currentTask();
    const currentModel = current?.snapshot().model ?? this.#selectedModel;
    if (value === "") {
      this.write(`model: ${currentModel}\n`);
      return;
    }
    const model = parseModelId(value);
    if (model === undefined) {
      this.write("model rejected: choose deepseek-flash, deepseek-pro, or minimax-m3\n");
      return;
    }
    if (this.#selectedAttachmentIds.length > 0 && model !== "MiniMax-M3" && current === undefined) {
      this.write("model rejected: image attachments require explicit :model minimax-m3\n");
      return;
    }
    if (current === undefined) {
      this.#selectedModel = model;
      this.write(`model selected: ${model}\n`);
      return;
    }
    const snapshot = current.snapshot();
    const metadata = this.#store.get(snapshot.taskId);
    if (metadata === undefined) {
      this.write(`model switch rejected: task ${snapshot.taskId} metadata is unavailable\n`);
      return;
    }
    if (snapshot.state === "running" || snapshot.state === "waiting_approval") {
      this.write(`model switch rejected: task ${snapshot.taskId} has an active turn\n`);
      return;
    }
    if (snapshot.state === "queued") {
      this.write(`model switch rejected: task ${snapshot.taskId} is queued\n`);
      return;
    }
    if (metadata.attachmentIds.length > 0 && model !== "MiniMax-M3") {
      this.write("model rejected: image attachments require explicit :model minimax-m3\n");
      return;
    }
    try {
      const updated = this.#store.updateModel(snapshot.taskId, snapshot.revision, model);
      this.#controllers.set(
        snapshot.taskId,
        new TaskController(snapshot.taskId, updated.approvalProfile, this.#store),
      );
      this.#selectedModel = model;
      this.write(`model selected: ${model} for ${snapshot.taskId}\n`);
    } catch (error) {
      this.write(`model switch rejected: ${safeError(error)}\n`);
    }
  }

  private async attachPath(value: string): Promise<void> {
    if (value === "") throw new Error("Attachment path is required.");
    if (!path.isAbsolute(value)) throw new Error("Attachment paths must be absolute.");
    const current = this.currentTask();
    const snapshot = current?.snapshot();
    const taskMetadata = snapshot === undefined ? undefined : this.#store.get(snapshot.taskId);
    if (snapshot !== undefined) {
      if (snapshot.state === "running" || snapshot.state === "waiting_approval")
        throw new Error("Attachments cannot change during an active turn.");
      if (snapshot.state === "queued")
        throw new Error("Attachments cannot change on a queued task.");
      if (snapshot.model !== "MiniMax-M3")
        throw new Error("Image attachments require explicit :model minimax-m3.");
    }
    const candidate = path.resolve(value);
    const source = await lstat(candidate);
    if (source.isSymbolicLink()) throw new Error("Symbolic links are not allowed for attachments.");
    if (!source.isFile()) throw new Error("Attachment path must be a regular file.");
    const canonical = await realpath(candidate);
    const canonicalWorkspace = await realpath(this.#workspacePath).catch(() => this.#workspacePath);
    const canonicalAppData = await realpath(this.#appDataRoot).catch(() => this.#appDataRoot);
    if (isPathInside(this.#workspacePath, candidate) || isPathInside(canonicalWorkspace, canonical))
      throw new Error("Workspace attachment paths are not allowed.");
    if (isPathInside(this.#appDataRoot, candidate) || isPathInside(canonicalAppData, canonical))
      throw new Error("Candy application-data attachment paths are not allowed.");
    if (isVideoAttachmentPath(candidate))
      throw new Error("Video attachments are unavailable until their provider gate passes.");
    const mimeType = attachmentMimeType(candidate);
    const content = await readAttachmentSource(candidate);
    const activeSecrets = this.#activeSecretsProvider?.() ?? [];
    const contentBuffer = Buffer.from(content);
    if (
      containsCredentialMaterial(contentBuffer.toString("utf8")) ||
      activeSecrets.some(
        (secret) => secret.length > 0 && contentBuffer.includes(Buffer.from(secret)),
      )
    ) {
      throw new Error("Attachment content contains credential material.");
    }
    const attachment = await this.#attachments.put("image", mimeType, content);
    if (snapshot === undefined) {
      if (!this.#selectedAttachmentIds.includes(attachment.id))
        this.#selectedAttachmentIds.push(attachment.id);
      this.write(`attachment staged: ${attachment.id}\n`);
      return;
    }
    if (taskMetadata === undefined) throw new Error("Task metadata is unavailable.");
    if (!taskMetadata.attachmentIds.includes(attachment.id)) {
      const updated = this.#store.updateAttachments(snapshot.taskId, snapshot.revision, [
        ...taskMetadata.attachmentIds,
        attachment.id,
      ]);
      this.#controllers.set(
        snapshot.taskId,
        new TaskController(snapshot.taskId, updated.approvalProfile, this.#store),
      );
    }
    this.write(`attachment added: ${attachment.id}\n`);
  }

  private async showAttachments(): Promise<void> {
    const current = this.currentTask();
    const taskId = current?.snapshot().taskId;
    const currentMetadata = taskId === undefined ? undefined : this.#store.get(taskId);
    const ids = currentMetadata?.attachmentIds ?? this.#selectedAttachmentIds;
    if (ids.length === 0) {
      this.write("attachments: none\n");
      return;
    }
    const lines = [`attachments${taskId === undefined ? "" : ` ${taskId}`}`];
    for (const id of ids) {
      try {
        const attachment = await this.#attachments.get(id);
        lines.push(`${id}\t${attachment.metadata.mimeType}\t${attachment.metadata.bytes} bytes`);
      } catch {
        lines.push(`${id}\tunavailable`);
      }
    }
    this.write(`${lines.join("\n")}\n`);
  }

  private configureValidator(value: string): void {
    if (value === "") {
      this.write(
        this.#validatorCommand === undefined
          ? "validator not configured; use :validator <absolute-executable> [args]\n"
          : `validator configured: ${this.#validatorCommand.executable} ${this.#validatorCommand.args.join(" ")}\n`,
      );
      return;
    }
    if (value === "off") {
      this.#validatorCommand = undefined;
      this.write("validator cleared for new tasks\n");
      return;
    }
    const parts = value.split(/\s+/u).filter((part) => part.length > 0);
    const executable = parts.shift();
    if (
      executable === undefined ||
      !isAbsoluteCommandPath(executable) ||
      parts.some((part) => containsControlCharacter(part)) ||
      containsCredentialMaterial(value)
    ) {
      this.write("validator rejected: use an absolute executable and safe direct arguments\n");
      return;
    }
    this.#validatorCommand = { executable, args: parts };
    this.write(`validator configured for new tasks: ${executable}\n`);
  }

  private async showChanges(): Promise<void> {
    const task = this.currentTask();
    if (task === undefined) {
      this.write("no current task; use :use <task-id> or create a task first\n");
      return;
    }
    const snapshot = this.#store.get(task.snapshot().taskId);
    if (snapshot === undefined) {
      this.write("current task metadata is unavailable\n");
      return;
    }
    const changes = await this.inspectWorkspaceChanges(snapshot);
    if (!changes.available) {
      this.write(`changed files: unavailable for ${snapshot.taskId}\n`);
      return;
    }
    this.recordWorkspaceReview(snapshot, changes, "manifest");
    const removed = extractRemovedPaths(changes.patchText);
    this.write(
      [
        `changed files: ${snapshot.taskId}`,
        `tracked: ${formatPaths(changes.tracked)}`,
        `untracked: ${formatPaths(changes.untracked)}`,
        `removed: ${formatPaths(removed)}`,
        ...(changes.patchTruncated ? ["diff: tracker output truncated"] : []),
        "",
      ].join("\n"),
    );
  }

  private async showDiff(requestedPath: string): Promise<void> {
    if (requestedPath !== "") assertSafeDiffPath(requestedPath);
    const task = this.currentTask();
    if (task === undefined) {
      this.write("no current task; use :use <task-id> or create a task first\n");
      return;
    }
    const snapshot = this.#store.get(task.snapshot().taskId);
    if (snapshot === undefined) {
      this.write("current task metadata is unavailable\n");
      return;
    }
    const completeDiff =
      requestedPath === "" ? await this.inspectCompleteDiff(snapshot) : undefined;
    const changes = completeDiff?.changes ?? (await this.inspectWorkspaceChanges(snapshot));
    if (!changes.available) {
      this.write(`diff unavailable for ${snapshot.taskId}\n`);
      return;
    }
    const selected =
      completeDiff === undefined ? selectDiff(changes.patchText, requestedPath) : completeDiff.text;
    const bounded = truncateTuiDiff(selected);
    const rendered = bounded || "(no diff)\n";
    this.write(
      `diff ${snapshot.taskId}${requestedPath === "" ? "" : ` ${requestedPath}`}\n${rendered}${rendered.endsWith("\n") ? "" : "\n"}`,
    );
    if (changes.patchTruncated) this.write("[diff truncated by workspace tracker]\n");
    if (
      requestedPath === "" &&
      !changes.patchTruncated &&
      completeDiff?.complete === true &&
      Buffer.byteLength(selected, "utf8") <= MAX_TUI_DIFF_BYTES
    ) {
      this.recordWorkspaceReview(
        snapshot,
        changes,
        "full-diff",
        completeDiff?.untrackedFingerprint,
      );
    }
  }

  private recordWorkspaceReview(
    snapshot: TaskMetadata,
    changes: WorkspaceChangeSnapshot,
    kind: "manifest" | "full-diff",
    untrackedFingerprint?: string,
  ): void {
    const previous = this.#workspaceReviews.get(snapshot.taskId);
    const compatible =
      previous !== undefined &&
      previous.revision === snapshot.revision &&
      sameWorkspaceChanges(previous.changes, changes);
    const review: TuiWorkspaceReview = {
      revision: snapshot.revision,
      changes,
      manifestReviewed: kind === "manifest" || (compatible && previous.manifestReviewed),
      fullDiffReviewed: kind === "full-diff" || (compatible && previous.fullDiffReviewed),
      ...(kind === "full-diff" && untrackedFingerprint !== undefined
        ? { untrackedFingerprint }
        : compatible && previous.untrackedFingerprint !== undefined
          ? { untrackedFingerprint: previous.untrackedFingerprint }
          : {}),
    };
    this.#store.updateReview(snapshot.taskId, review);
    this.#workspaceReviews.set(snapshot.taskId, review);
  }

  private async applyCurrent(): Promise<void> {
    const snapshot = this.requireCompletedWorktree("Apply Changes");
    const review =
      this.#workspaceReviews.get(snapshot.taskId) ?? this.#store.getReview(snapshot.taskId);
    if (
      review === undefined ||
      review.revision !== snapshot.revision ||
      !review.manifestReviewed ||
      !review.fullDiffReviewed ||
      review.untrackedFingerprint === undefined
    ) {
      throw new ApplyChangesBlockedError(
        "Review the complete current change list with :changes and the full diff with :diff before Apply.",
      );
    }
    await this.withActiveSecrets(async (activeSecrets) => {
      const current = await this.#changeTracker.inspect(
        snapshot.worktreePath!,
        snapshot.workspaceBaseline,
        [],
      );
      const sanitizedCurrent = sanitizeWorkspaceChanges(current, activeSecrets);
      const untracked = await buildUntrackedReview(
        snapshot.worktreePath!,
        current.untracked,
        activeSecrets,
      );
      if (
        current.patchTruncated ||
        !untracked.complete ||
        !sameWorkspaceChanges(review.changes, sanitizedCurrent) ||
        review.untrackedFingerprint !== untracked.fingerprint
      ) {
        throw new ApplyChangesBlockedError("Reviewed workspace changed before Apply.");
      }
      await new ApplyChangesService(snapshot.workspacePath).apply(snapshot.worktreePath!, {
        targetIsGit: true,
        targetClean: true,
        expectedBase: snapshot.workspaceBaseline!,
        actualBase: snapshot.workspaceBaseline!,
        paths: [...current.tracked, ...current.untracked],
        untrackedPaths: current.untracked,
        patchText: current.patchText,
        activeSecrets,
      });
    });
    try {
      await this.#worktreeManager.discard(this.planFromMetadata(snapshot));
    } catch (error) {
      throw new Error(
        "Changes were applied to Local Workspace, but Task Worktree cleanup failed.",
        {
          cause: error,
        },
      );
    }
    this.#store.updateWorktree(snapshot.taskId);
    this.refreshController(snapshot.taskId);
    this.#workspaceReviews.delete(snapshot.taskId);
    this.#store.clearReview(snapshot.taskId);
    this.write(`applied ${snapshot.taskId} to Local Workspace; Task Worktree removed\n`);
  }

  private async discardCurrent(): Promise<void> {
    const snapshot = this.requireCompletedWorktree("Discard");
    try {
      await this.#worktreeManager.discard(this.planFromMetadata(snapshot));
    } catch (error) {
      throw new Error("Task Worktree discard failed.", { cause: error });
    }
    this.#store.updateWorktree(snapshot.taskId);
    this.refreshController(snapshot.taskId);
    this.#workspaceReviews.delete(snapshot.taskId);
    this.#store.clearReview(snapshot.taskId);
    this.write(`discarded ${snapshot.taskId}; Local Workspace unchanged\n`);
  }

  private requireCompletedWorktree(operation: string): TaskMetadata {
    const task = this.currentTask();
    if (task === undefined) throw new Error(`${operation} requires a current task.`);
    const snapshot = this.#store.get(task.snapshot().taskId);
    if (snapshot === undefined) throw new Error(`${operation} task metadata is unavailable.`);
    if (snapshot.state !== "completed") throw new Error(`${operation} requires a completed task.`);
    if (snapshot.ownerId !== undefined)
      throw new Error(`${operation} requires released task ownership.`);
    if (snapshot.worktreePath === undefined)
      throw new Error(`${operation} requires a Git Task Worktree.`);
    if (snapshot.workspaceBaseline === undefined)
      throw new Error(`${operation} Task Worktree baseline is unavailable.`);
    return snapshot;
  }

  private planForTask(taskId: string, workspacePath: string, baseCommit: string): GitWorktreePlan {
    return planGitWorktree(
      workspacePath,
      path.join(this.#worktreeRoot, taskId),
      taskId,
      baseCommit,
    );
  }

  private planFromMetadata(snapshot: TaskMetadata): GitWorktreePlan {
    return planGitWorktree(
      snapshot.workspacePath,
      snapshot.worktreePath!,
      snapshot.taskId,
      snapshot.workspaceBaseline!,
    );
  }

  private refreshController(taskId: string): void {
    const metadata = this.#store.get(taskId);
    if (metadata === undefined) return;
    this.#controllers.set(
      taskId,
      new TaskController(taskId, metadata.approvalProfile, this.#store),
    );
  }

  private currentTask(): TaskController | undefined {
    return this.#currentTaskId === undefined
      ? undefined
      : this.ensureController(this.#currentTaskId);
  }

  private async inspectWorkspaceChanges(snapshot: TaskMetadata): Promise<WorkspaceChangeSnapshot> {
    return this.withActiveSecrets(async (activeSecrets) =>
      sanitizeWorkspaceChanges(
        await this.#changeTracker.inspect(
          snapshot.worktreePath ?? snapshot.workspacePath,
          snapshot.workspaceBaseline,
          [],
        ),
        activeSecrets,
      ),
    );
  }

  private async inspectCompleteDiff(snapshot: TaskMetadata): Promise<TuiCompleteDiff> {
    return this.withActiveSecrets(async (activeSecrets) => {
      const executionPath = snapshot.worktreePath ?? snapshot.workspacePath;
      const raw = await this.#changeTracker.inspect(executionPath, snapshot.workspaceBaseline, []);
      const changes = sanitizeWorkspaceChanges(raw, activeSecrets);
      const untracked = await buildUntrackedReview(executionPath, raw.untracked, activeSecrets);
      return {
        changes,
        text: [changes.patchText, untracked.text].filter((value) => value.length > 0).join("\n"),
        untrackedFingerprint: untracked.fingerprint,
        complete: untracked.complete,
      };
    });
  }

  private validateCurrent(): void {
    const task = this.currentTask();
    if (task === undefined) {
      this.write("no current task; use :use <task-id> or create a task first\n");
      return;
    }
    const snapshot = task.snapshot();
    if (snapshot.state === "running" || snapshot.state === "waiting_approval") {
      this.write(`task ${snapshot.taskId} is already running; validator is not started\n`);
      return;
    }
    const metadata = this.#store.get(snapshot.taskId);
    if (metadata?.validator === undefined) {
      this.write("validator not configured for this task; configure it before :new\n");
      return;
    }
    if (this.#validator === undefined) {
      this.#validatorStates.set(snapshot.taskId, {
        status: "blocked",
        evidence: "native runner unavailable",
      });
      this.write("validator blocked: native Sandbox Runner is unavailable on this installation\n");
      return;
    }
    if (this.#validatorAbortControllers.has(snapshot.taskId)) {
      this.write(`validator running: ${snapshot.taskId}\n`);
      return;
    }
    const abort = new AbortController();
    this.#validatorAbortControllers.set(snapshot.taskId, abort);
    this.#validatorStates.set(snapshot.taskId, { status: "running" });
    this.write(`validator running: ${snapshot.taskId}\n`);
    const operation = this.runValidator(metadata, abort);
    this.#validatorRuns.set(snapshot.taskId, operation);
    void operation
      .catch((error: unknown) => {
        if (!this.#closing) this.write(`validator failed: ${safeError(error)}\n`);
      })
      .finally(() => {
        if (this.#validatorRuns.get(snapshot.taskId) === operation)
          this.#validatorRuns.delete(snapshot.taskId);
      });
  }

  private async runValidator(snapshot: TaskMetadata, abort: AbortController): Promise<void> {
    const timeoutHandle = setTimeout(() => {
      this.#validatorStops.set(snapshot.taskId, "timeout");
      abort.abort(new Error("validator timeout"));
    }, this.#validatorTimeoutMs);
    timeoutHandle.unref?.();
    try {
      const outcome = await this.withActiveSecrets(async (activeSecrets) => ({
        activeSecrets,
        result: await this.#validator!.run(
          snapshot.validator!,
          snapshot.worktreePath ?? snapshot.workspacePath,
          abort.signal,
          activeSecrets,
        ),
      }));
      const requestedStop = this.#validatorStops.get(snapshot.taskId);
      const status: Exclude<TuiValidatorStatus, "configured" | "running" | "blocked"> =
        requestedStop === "timeout"
          ? "timeout"
          : requestedStop === "cancelled" || abort.signal.aborted
            ? "cancelled"
            : outcome.result.ok
              ? "pass"
              : "fail";
      this.finishValidator(
        snapshot.taskId,
        status,
        redactSensitive(outcome.result.evidence, outcome.activeSecrets),
        outcome.result.durationMs,
      );
    } catch (error) {
      const requestedStop = this.#validatorStops.get(snapshot.taskId);
      const status: Exclude<TuiValidatorStatus, "configured" | "running" | "blocked"> =
        requestedStop === "timeout"
          ? "timeout"
          : requestedStop === "cancelled" || abort.signal.aborted
            ? "cancelled"
            : "fail";
      this.finishValidator(
        snapshot.taskId,
        status,
        status === "timeout"
          ? "validator timeout"
          : status === "cancelled"
            ? "validator cancelled"
            : safeError(error),
      );
    } finally {
      clearTimeout(timeoutHandle);
      this.#validatorAbortControllers.delete(snapshot.taskId);
      this.#validatorStops.delete(snapshot.taskId);
    }
  }

  private finishValidator(
    taskId: string,
    status: Exclude<TuiValidatorStatus, "configured" | "running" | "blocked">,
    evidence: string,
    durationMs?: number,
  ): void {
    const boundedEvidence = evidence.slice(0, 4_096);
    this.#validatorStates.set(taskId, {
      status,
      evidence: boundedEvidence,
      ...(durationMs === undefined ? {} : { durationMs }),
    });
    this.#store.recordRun({
      taskId,
      rounds: 1,
      evidenceCount: 1,
      completed: status === "pass",
      stopReason:
        status === "pass" ? "validator_succeeded" : status === "cancelled" ? "cancelled" : "error",
      evidenceSummary: boundedEvidence,
    });
    this.#store.appendTranscript(taskId, [
      { role: "tool", text: transcriptText(`validator ${status}: ${boundedEvidence}`) },
    ]);
    this.write(`validator ${status}: ${boundedEvidence}\n`);
  }

  private async withActiveSecrets<T>(
    callback: (activeSecrets: readonly string[]) => Promise<T>,
  ): Promise<T> {
    if (this.#activeSecretsProvider !== undefined) return callback(this.#activeSecretsProvider());
    const leases: NonNullable<ReturnType<typeof resolveCredential>>[] = [];
    for (const provider of ["deepseek", "minimax-cn"] as const) {
      try {
        const lease = resolveCredential(
          provider,
          this.#credentialEnvironment,
          this.#credentialStore,
        );
        if (lease !== undefined) leases.push(lease);
      } catch {
        // Presence is optional; the provider path reports needs_credentials when used.
      }
    }
    try {
      return await callback(leases.map((lease) => lease.value));
    } finally {
      for (const lease of leases) lease.release();
    }
  }

  private activeSecretsSnapshot(): readonly string[] {
    if (this.#activeSecretsProvider !== undefined) return this.#activeSecretsProvider();
    return resolveActiveTuiProviderSecrets(this.#credentialEnvironment, this.#credentialStore);
  }

  private hasActiveProviderSecret(value: string): boolean {
    return this.activeSecretsSnapshot().some(
      (secret) => secret.length > 0 && value.includes(secret),
    );
  }

  private useTask(taskId: string): void {
    const task = this.ensureController(taskId);
    if (!task) {
      this.write(`task ${taskId} does not exist\n`);
      return;
    }
    this.#currentTaskId = taskId;
    const snapshot = task.snapshot();
    if (
      snapshot.state === "running" &&
      snapshot.ownerId !== undefined &&
      snapshot.ownerId !== this.#ownerId
    ) {
      this.write(
        `current task: ${taskId} (read-only task: ${taskId}; owned by ${snapshot.ownerId})\n`,
      );
      return;
    }
    this.write(`current task: ${taskId} (${snapshot.state})\n`);
  }

  private showTranscript(requestedTaskId: string): void {
    const taskId = requestedTaskId || this.#currentTaskId;
    if (taskId === undefined) {
      this.write("no current task; use :use <task-id> or create a task first\n");
      return;
    }
    const transcript = this.#store.transcript(taskId);
    if (transcript === undefined) {
      this.write(`transcript unavailable for ${taskId}\n`);
      return;
    }
    this.write(
      truncateTuiTranscript(
        [
          `transcript ${taskId}`,
          ...transcript.map((entry) => `${entry.role}: ${entry.text}`),
          "",
        ].join("\n"),
      ),
    );
  }

  private listPromptTemplates(): void {
    const result = loadCandyPromptTemplates(this.#appDataRoot, this.activeSecretsSnapshot());
    for (const diagnostic of result.diagnostics) {
      this.write(`prompt resource ${diagnostic.type}: ${diagnostic.message}\n`);
    }
    if (result.templates.length === 0) {
      this.write("no Candy prompt templates found\n");
      return;
    }
    for (const template of result.templates) {
      this.write(`${template.name}\t${template.description}\t${template.argumentHint ?? ""}\n`);
    }
  }

  private showResourceDiagnostics(): void {
    const diagnostics = loadCandyResourceDiagnostics(
      this.#appDataRoot,
      this.activeSecretsSnapshot(),
    );
    if (diagnostics.length === 0) {
      this.write("Candy resources: no diagnostics\n");
      return;
    }
    for (const diagnostic of diagnostics) {
      this.write(
        `${diagnostic.category} resource ${diagnostic.type}: ${diagnostic.message} (${diagnostic.path})\n`,
      );
    }
  }

  private invokePromptTemplate(value: string): void {
    const separator = value.search(/[\s]/u);
    const name = separator < 0 ? value : value.slice(0, separator);
    const argumentText = separator < 0 ? "" : value.slice(separator).trim();
    if (name.length === 0) {
      this.write("usage: :prompt <name> [arguments]\n");
      return;
    }
    if (
      argumentText.length > MAX_TUI_TURN_MESSAGE_CHARS ||
      containsControlCharacter(argumentText)
    ) {
      this.write("prompt arguments rejected: text is outside the allowed bounds\n");
      return;
    }
    const args = parseTuiPromptArguments(argumentText);
    if (args === undefined) {
      this.write("prompt arguments rejected: unmatched quote\n");
      return;
    }
    const result = loadCandyPromptTemplates(this.#appDataRoot, this.activeSecretsSnapshot());
    for (const diagnostic of result.diagnostics) {
      this.write(`prompt resource ${diagnostic.type}: ${diagnostic.message}\n`);
    }
    const template = result.templates.find((candidate) => candidate.name === name);
    if (template === undefined) {
      this.write(`prompt template not found: ${name}\n`);
      return;
    }
    const prompt = expandTuiPromptTemplate(template, args);
    if (prompt.trim().length === 0) {
      this.write(`prompt template is empty: ${name}\n`);
      return;
    }
    this.submitPrompt(prompt);
  }

  private async runTask(
    task: TaskController,
    abort: AbortController,
    explicitPrompt?: string,
  ): Promise<void> {
    const taskId = task.snapshot().taskId;
    try {
      this.#workspaceReviews.delete(taskId);
      this.#store.clearReview(taskId);
      const taskSnapshot = this.#store.get(taskId);
      if (taskSnapshot === undefined) throw new Error("Task metadata is unavailable after start.");
      if (
        taskSnapshot.trustedShell &&
        (!this.#trustedShellAutoAvailable || !isTrustedShellAutoAvailableOnHost())
      )
        throw new Error(
          process.platform === "win32"
            ? getWindowsTrustedShellCapabilityStatus().reason
            : "Trusted Shell Auto is disabled pending the macOS G2 gate.",
        );
      const executionPath = await this.resolveExecutionPath(taskSnapshot);
      const trustedGitCommonDirectory =
        taskSnapshot.trustedShell && this.#engine instanceof TuiModelRouter
          ? await resolveGitCommonDirectory(taskSnapshot.workspacePath)
          : undefined;
      const prompt = explicitPrompt;
      if (prompt === undefined)
        throw new Error("Explicit continuation required; the interrupted prompt was not replayed.");
      if (explicitPrompt !== undefined) {
        this.write(`\n[user] ${transcriptText(explicitPrompt)}\n`);
        this.#store.appendTranscript(taskId, [
          { role: "user", text: transcriptText(explicitPrompt) },
        ]);
      }
      const attachments =
        taskSnapshot.attachmentIds.length === 0
          ? undefined
          : await Promise.all(
              taskSnapshot.attachmentIds.map((id) => this.#attachments.getImagePayload(id)),
            );
      if (attachments !== undefined && taskSnapshot.model !== "MiniMax-M3") {
        throw new Error("DeepSeek does not accept image attachments; switch to MiniMax M3.");
      }
      const runEngineTurn = async (activeSecrets: readonly string[]): Promise<void> => {
        for await (const observation of this.#engine.runTurn(
          {
            taskId,
            prompt,
            model: taskSnapshot.model,
            cwd: executionPath,
            approvalProfile: taskSnapshot.approvalProfile,
            activeSecrets,
            ...(taskSnapshot.approvalProfile === "auto"
              ? {
                  fileDeleteApproval: (request: FileDeleteApprovalRequest, signal: AbortSignal) =>
                    this.requestFileDeleteApproval(taskId, request, signal, activeSecrets),
                }
              : {}),
            ...(taskSnapshot.trustedShell
              ? {
                  trustedShell: true,
                  ...(trustedGitCommonDirectory === undefined ? {} : { trustedGitCommonDirectory }),
                  ...(this.#shellRunner?.bashPath === undefined
                    ? {}
                    : { bashPath: this.#shellRunner.bashPath }),
                  shellActiveSecrets: activeSecrets,
                  shellNetworkApproval: (
                    request: CandyNetworkApprovalRequest,
                    signal: AbortSignal,
                  ) => this.requestNetworkApproval(taskId, request, signal),
                }
              : {}),
            ...(attachments === undefined
              ? {}
              : {
                  images: attachments.map(({ mimeType, data }) => ({ mimeType, data })),
                }),
          },
          abort.signal,
        )) {
          if (observation.type === "assistant.delta") {
            const safeText = redactSensitive(observation.text, activeSecrets);
            this.write(safeText);
            this.#store.appendTranscript(taskId, [
              { role: "assistant", text: transcriptText(safeText) },
            ]);
          }
          if (observation.type === "tool.started") {
            const tool = boundedToolName(observation.tool, activeSecrets);
            const args = boundedToolDetail(observation.args, activeSecrets);
            const detail = args === undefined ? "" : ` args=${args}`;
            this.write(`\n[tool ${tool}${detail}]\n`);
            this.#store.appendTranscript(taskId, [
              { role: "tool", text: transcriptText(`${tool}:started${detail}`) },
            ]);
          }
          if (observation.type === "tool.updated") {
            const tool = boundedToolName(observation.tool, activeSecrets);
            const output = boundedToolDetail(observation.output, activeSecrets) ?? "(no output)";
            this.write(`\n[tool ${tool} output=${output}]\n`);
          }
          if (observation.type === "tool.completed") {
            const tool = boundedToolName(observation.tool, activeSecrets);
            const output = boundedToolDetail(observation.output, activeSecrets);
            const detail = output === undefined ? "" : ` output=${output}`;
            this.write(`\n[tool ${tool}${detail}]\n`);
            this.#store.appendTranscript(taskId, [
              {
                role: "tool",
                text: transcriptText(`${tool}:${observation.ok ? "ok" : "error"}${detail}`),
              },
            ]);
          }
          if (observation.type === "turn.retrying") {
            this.write(
              `\n[provider retry ${observation.attempt}/${observation.maxAttempts}; waiting ${observation.delayMs}ms]\n`,
            );
          }
          if (observation.type === "turn.retry.completed") {
            this.write(
              observation.ok
                ? `\n[provider retry ${observation.attempt} succeeded]\n`
                : `\n[provider retry ${observation.attempt} failed]\n`,
            );
          }
          if (observation.type === "turn.compaction") {
            this.write(
              observation.phase === "started"
                ? `\n[context compaction: ${observation.reason}]\n`
                : `\n[context compaction ${observation.aborted ? "cancelled" : "settled"}: ${observation.reason}]\n`,
            );
          }
          if (observation.type === "turn.settled") this.write("\n[turn settled]\n");
        }
      };
      await this.withActiveSecrets((activeSecrets) => runEngineTurn(activeSecrets));
      if (this.#closing || abort.signal.aborted)
        throw new Error(this.#closing ? "TUI exit interrupted the task." : "Task owner lost.");
      const current = task.snapshot();
      if (current.state === "running") {
        const completed = task.transition("completed", current.revision);
        this.write(`\n${completed.taskId} completed\n`);
      }
    } catch (error) {
      const current = task.snapshot();
      if (current.state === "running") {
        const requestedStop = this.#requestedStops.get(taskId);
        const nextState = requestedStop ?? (abort.signal.aborted ? "cancelled" : "interrupted");
        let stoppedState: "paused" | "cancelled" | "interrupted" | undefined;
        try {
          const stopped = task.transition(nextState, current.revision);
          stoppedState = nextState;
          this.write(`\n${stopped.taskId} ${stopped.state}: ${safeError(error)}\n`);
        } catch {
          const persisted = this.#store.get(taskId);
          if (
            persisted === undefined ||
            (persisted.state !== "interrupted" &&
              persisted.state !== "paused" &&
              persisted.state !== "cancelled")
          )
            throw error;
        }
        if (error instanceof ProviderContractError && stoppedState === "interrupted") {
          this.write(
            `recovery: :resume ${taskId} <continuation>, :model deepseek-pro, or :cancel ${taskId}\n`,
          );
        }
      }
    } finally {
      this.stopOwnerWatch(taskId);
      this.#abortControllers.delete(taskId);
      this.#requestedStops.delete(taskId);
      this.#scheduler.finish(taskId);
      if (!this.#closing) this.drain();
    }
  }

  private async cancel(taskId: string): Promise<void> {
    const validatorAbort = this.#validatorAbortControllers.get(taskId);
    if (validatorAbort !== undefined) {
      this.#validatorStops.set(taskId, "cancelled");
      validatorAbort.abort(new Error("validator cancelled"));
      return;
    }
    const abort = this.#abortControllers.get(taskId);
    if (abort) {
      this.#requestedStops.set(taskId, "cancelled");
      abort.abort();
      return;
    }
    const task = this.#controllers.get(taskId);
    if (task?.snapshot().state === "queued") {
      this.#scheduler.cancelQueued(taskId);
      task.transition("cancelled", task.snapshot().revision);
      this.write(`${taskId} cancelled before start\n`);
      return;
    }
    if (task?.snapshot().state === "paused" || task?.snapshot().state === "interrupted") {
      task.transition("cancelled", task.snapshot().revision);
      this.write(`${taskId} cancelled\n`);
      return;
    }
    this.write(`${taskId} is not an active task\n`);
  }

  private async queueActiveTurnMessage(mode: "steer" | "followUp", text: string): Promise<void> {
    if (text.length === 0) {
      this.write(`:${mode === "steer" ? "steer" : "follow-up"} requires text\n`);
      return;
    }
    if (text.length > MAX_TUI_TURN_MESSAGE_CHARS) {
      this.write(`turn message rejected: text exceeds ${MAX_TUI_TURN_MESSAGE_CHARS} characters\n`);
      return;
    }
    if (containsControlCharacter(text)) {
      this.write("turn message rejected: control characters are forbidden\n");
      return;
    }
    if (containsCredentialMaterial(text) || this.hasActiveProviderSecret(text)) {
      this.write("turn message rejected: credential material is forbidden\n");
      return;
    }
    const task = this.currentTask();
    const snapshot = task?.snapshot();
    if (task === undefined || snapshot === undefined) {
      this.write("no current task; create or select a task first\n");
      return;
    }
    if (snapshot.state !== "running") {
      this.write(
        `task ${snapshot.taskId} has no active turn to ${mode === "steer" ? "steer" : "follow up"}\n`,
      );
      return;
    }
    if (snapshot.ownerId !== this.#ownerId) {
      this.write(
        `task ${snapshot.taskId} is read-only: owned by ${snapshot.ownerId ?? "another client"}\n`,
      );
      return;
    }
    const queue = this.#engine[mode];
    if (queue === undefined) {
      this.write(
        `task ${snapshot.taskId} does not expose ${mode === "steer" ? "steering" : "follow-up"} control\n`,
      );
      return;
    }
    try {
      await queue.call(this.#engine, snapshot.taskId, text);
      this.#store.appendTranscript(snapshot.taskId, [
        {
          role: "user",
          text: transcriptText(`[${mode === "steer" ? "steer" : "follow-up"}] ${text}`),
        },
      ]);
      this.write(`\n[${mode === "steer" ? "steer" : "follow-up"}] ${transcriptText(text)}\n`);
      this.write(`${snapshot.taskId} ${mode === "steer" ? "steering" : "follow-up"} queued\n`);
    } catch (error) {
      this.write(
        `${snapshot.taskId} ${mode === "steer" ? "steering" : "follow-up"} rejected: ${safeError(error)}\n`,
      );
    }
  }

  private startOwnerWatch(taskId: string, abort: AbortController): void {
    this.stopOwnerWatch(taskId);
    const watcher = setInterval(() => {
      if (this.#closing || abort.signal.aborted) return;
      const metadata = this.#store.get(taskId);
      if (
        metadata?.ownerId !== this.#ownerId ||
        (metadata.state !== "running" && metadata.state !== "waiting_approval")
      ) {
        this.#requestedStops.set(taskId, "interrupted");
        abort.abort(new Error("Task execution owner was lost."));
      }
    }, 50);
    watcher.unref?.();
    this.#ownerWatchers.set(taskId, watcher);
  }

  private stopOwnerWatch(taskId: string): void {
    const watcher = this.#ownerWatchers.get(taskId);
    if (watcher === undefined) return;
    clearInterval(watcher);
    this.#ownerWatchers.delete(taskId);
  }

  private pause(taskId: string): void {
    const abort = this.#abortControllers.get(taskId);
    if (abort) {
      this.#requestedStops.set(taskId, "paused");
      abort.abort();
      return;
    }
    const task = this.#controllers.get(taskId);
    if (task?.snapshot().state === "queued") {
      this.#scheduler.cancelQueued(taskId);
      task.transition("paused", task.snapshot().revision);
      this.write(`${taskId} paused before start\n`);
    } else {
      this.write(`${taskId} is not pausable\n`);
    }
  }

  private prioritize(taskId: string): void {
    const next = this.#scheduler.queued().find((candidate) => candidate !== taskId);
    if (next === undefined) {
      this.write(`${taskId} is already next or is not queued\n`);
      return;
    }
    if (this.#scheduler.moveQueuedBefore(taskId, next)) {
      this.write(`${taskId} moved to the front of the queue\n`);
    } else {
      this.write(`${taskId} is not queued\n`);
    }
  }

  private resume(taskId: string, continuation?: string): void {
    const task = this.#controllers.get(taskId);
    if (task?.snapshot().state === "paused" || task?.snapshot().state === "interrupted") {
      if (continuation === undefined || continuation.length === 0) {
        this.#currentTaskId = taskId;
        this.write(
          `${taskId} requires an explicit continuation; no interrupted prompt was replayed.\n`,
        );
        this.showTranscript(taskId);
        this.write(`use :resume ${taskId} <continuation> after reviewing the saved evidence\n`);
        return;
      }
      if (containsCredentialMaterial(continuation) || this.hasActiveProviderSecret(continuation)) {
        this.write("continuation rejected: credential material is forbidden\n");
        return;
      }
      this.#scheduler.enqueue(taskId);
      this.write(`${taskId} queued for explicit continuation\n`);
      this.drain(new Map([[taskId, continuation]]));
    } else {
      this.write(`${taskId} is not resumable\n`);
    }
  }

  private printTasks(): void {
    for (const task of this.#store.list()) {
      const current = task.taskId === this.#currentTaskId ? "*" : " ";
      const validator = this.validatorStatus(task);
      const workspaceState = task.worktreePath === undefined ? "local" : "worktree";
      this.write(
        `${current}${task.taskId}\t${task.state}\t${task.model}\t${task.workspacePath}\tr${task.revision}\tq${task.queueOrder ?? "-"}\tworkspace=${workspaceState}\ttrusted-shell=${task.trustedShell ? "on" : "off"}\tvalidator=${validator}\n`,
      );
    }
  }

  private validatorStatus(task: TaskMetadata): string {
    const state = this.#validatorStates.get(task.taskId);
    if (state !== undefined) return state.status;
    if (task.validator === undefined) return "not-configured";
    const run = this.#store.getRun(task.taskId);
    if (run?.stopReason === "validator_succeeded") return "pass";
    if (run?.stopReason === "cancelled") return "cancelled";
    if (run?.stopReason === "error") return "fail";
    return "configured";
  }

  private setProfile(value: string): void {
    if (value !== "read-only" && value !== "auto") {
      this.write("profile must be read-only or auto\n");
      return;
    }
    this.#approvalProfile = value;
    if (value === "read-only") this.#trustedShellEnabled = false;
    this.write(
      value === "auto"
        ? `profile auto: file read/create/edit enabled; delete requires confirmation; Trusted Shell Auto ${this.#trustedShellEnabled ? "on" : "off"}\n`
        : "profile read-only: file mutation disabled\n",
    );
  }

  private setTrustedShell(value: string): void {
    if (value === "") {
      this.write(`Trusted Shell Auto: ${this.#trustedShellEnabled ? "on" : "off"}\n`);
      return;
    }
    if (value !== "on" && value !== "off" && value !== "auto") {
      this.write("trusted-shell must be on, off, or auto\n");
      return;
    }
    if (value === "off") {
      this.#trustedShellEnabled = false;
      this.write("Trusted Shell Auto disabled for new tasks\n");
      return;
    }
    if (process.platform !== "darwin" && process.platform !== "win32") {
      this.write("Trusted Shell Auto rejected: Personal Preview is unavailable on this platform\n");
      return;
    }
    if (this.#approvalProfile !== "auto") {
      this.write("Trusted Shell Auto rejected: select :profile auto first\n");
      return;
    }
    if (this.#shellRunner === undefined) {
      this.write(
        "Trusted Shell Auto rejected: Native Sandbox Runner is unavailable on this installation\n",
      );
      return;
    }
    if (!this.#trustedShellAutoAvailable || !isTrustedShellAutoAvailableOnHost()) {
      if (process.platform === "win32") {
        this.write(
          `Trusted Shell Auto rejected: ${getWindowsTrustedShellCapabilityStatus().reason}\n`,
        );
      } else {
        this.write("Trusted Shell Auto rejected: the macOS G2 gate has not enabled this build\n");
      }
      return;
    }
    this.#trustedShellEnabled = true;
    this.write(
      "Trusted Shell Auto enabled for the next Auto Git Task; offline commands run automatically\n",
    );
  }

  private requestFileDeleteApproval(
    taskId: string,
    request: FileDeleteApprovalRequest,
    signal: AbortSignal,
    activeSecrets: readonly string[],
  ): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    const approvalId = `delete-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (approved: boolean): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", denyOnAbort);
        this.#deleteApprovals.delete(approvalId);
        resolve(approved);
      };
      const denyOnAbort = (): void => settle(false);
      this.#deleteApprovals.set(approvalId, { taskId, settle });
      signal.addEventListener("abort", denyOnAbort, { once: true });
      const safePath = redactSensitive(request.path, activeSecrets);
      this.write(
        `\napproval required: delete ${safePath}\n:approve ${approvalId} or :deny ${approvalId}\n`,
      );
    });
  }

  private async requestNetworkApproval(
    taskId: string,
    request: CandyNetworkApprovalRequest,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted || this.#closing) return false;
    const task = this.ensureController(taskId);
    if (task === undefined) return false;
    const taskSnapshot = task.snapshot();
    if (taskSnapshot.state !== "running") return false;
    const taskMetadata = this.#store.get(taskId);
    if (taskMetadata?.worktreePath === undefined) return false;
    const [canonicalTaskWorktree, canonicalRequestCwd, taskRoot] = await Promise.all([
      realpath(taskMetadata.worktreePath).catch(() => undefined),
      realpath(request.cwd).catch(() => undefined),
      lstat(taskMetadata.worktreePath).catch(() => undefined),
    ]);
    if (
      canonicalTaskWorktree === undefined ||
      canonicalRequestCwd === undefined ||
      canonicalTaskWorktree !== canonicalRequestCwd ||
      taskRoot?.isSymbolicLink() === true
    )
      return false;
    const current = task.snapshot();
    if (
      signal.aborted ||
      this.#closing ||
      current.state !== "running" ||
      current.ownerId !== this.#ownerId
    )
      return false;
    const approvalId = `network-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (approved: boolean): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", denyOnAbort);
        this.#networkApprovals.delete(approvalId);
        const persisted = this.#store.get(taskId);
        const ownsWaitingTask =
          !this.#closing &&
          persisted?.state === "waiting_approval" &&
          persisted.ownerId === this.#ownerId;
        if (ownsWaitingTask) {
          try {
            const latest = task.snapshot();
            if (latest.state === "waiting_approval") task.transition("running", latest.revision);
          } catch {
            // A concurrent owner fence wins over a pending approval.
          }
        }
        resolve(approved && ownsWaitingTask && !signal.aborted);
      };
      const denyOnAbort = (): void => settle(false);
      this.#networkApprovals.set(approvalId, { taskId, settle });
      signal.addEventListener("abort", denyOnAbort, { once: true });
      const latest = task.snapshot();
      if (
        signal.aborted ||
        this.#closing ||
        latest.state !== "running" ||
        latest.ownerId !== this.#ownerId
      ) {
        settle(false);
        return;
      }
      try {
        task.transition("waiting_approval", latest.revision);
      } catch {
        settle(false);
        return;
      }
      this.write(
        [
          "\nnetwork approval required",
          `command: ${formatApprovalField(request.command)}`,
          `reason: ${formatApprovalField(request.reason)}`,
          `cwd: ${formatApprovalField(canonicalTaskWorktree)}`,
          `timeout: ${request.timeout === undefined ? "none" : `${request.timeout}s`}`,
          `:approve ${approvalId} or :deny ${approvalId}`,
          "",
        ].join("\n"),
      );
    });
  }

  private recoverStaleTuiOwners(): void {
    for (const metadata of this.#store.list()) {
      if (
        (metadata.state !== "running" && metadata.state !== "waiting_approval") ||
        metadata.ownerId === undefined ||
        !metadata.ownerId.startsWith("tui:") ||
        isTuiOwnerAlive(metadata.ownerId)
      )
        continue;
      this.#store.markOwnerInterrupted(metadata.ownerId);
    }
  }

  private async resolveExecutionPath(metadata: TaskMetadata): Promise<string> {
    const executionPath = metadata.worktreePath ?? metadata.workspacePath;
    if (!metadata.trustedShell) return executionPath;
    if (metadata.worktreePath === undefined)
      throw new Error("Trusted Shell Auto requires a Git Task Worktree.");
    const [canonicalPath, root] = await Promise.all([
      realpath(metadata.worktreePath).catch(() => undefined),
      lstat(metadata.worktreePath).catch(() => undefined),
    ]);
    if (canonicalPath === undefined || root?.isSymbolicLink() === true)
      throw new Error("Trusted Shell Task Worktree is unavailable or symlinked.");
    return canonicalPath;
  }

  private resolveDeleteApproval(approvalId: string, approved: boolean): void {
    const approval = this.#deleteApprovals.get(approvalId);
    if (approval !== undefined) {
      approval.settle(approved);
      this.write(`${approval.taskId} deletion ${approved ? "approved" : "denied"}\n`);
      return;
    }
    const networkApproval = this.#networkApprovals.get(approvalId);
    if (networkApproval !== undefined) {
      networkApproval.settle(approved);
      this.write(`${networkApproval.taskId} network ${approved ? "approved" : "denied"}\n`);
      return;
    }
    this.write(`${approvalId} is not awaiting approval\n`);
  }

  private write(value: string): void {
    this.#surface?.appendTranscript(redactTuiOutput(value));
  }
}

async function readAttachmentSource(candidate: string): Promise<Buffer> {
  const handle = await open(candidate, fsConstants.O_RDONLY | NO_FOLLOW_FINAL_PATH);
  try {
    const file = await handle.stat();
    if (!file.isFile()) throw new Error("Attachment path must be a regular file.");
    if (file.size > MAX_ATTACHMENT_BYTES)
      throw new Error(`Attachment exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit.`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function createNativeTuiValidator(): TuiValidator | undefined {
  const runnerPath = resolveNativeProcessRunnerPath(import.meta.url);
  if (runnerPath === undefined) return undefined;
  const commandValidator = new CommandValidator(new NativeProcessRunner(runnerPath));
  return {
    run: (command, workspace, signal, activeSecrets) =>
      commandValidator.run(command, workspace, signal, {}, activeSecrets),
  };
}

function createNativeTuiShellRunner(): TuiShellRunner | undefined {
  if (process.platform !== "darwin" && process.platform !== "win32") return undefined;
  const runnerPath = resolveNativeProcessRunnerPath(import.meta.url);
  if (runnerPath === undefined) return undefined;
  if (process.platform === "win32") {
    try {
      return {
        bashPath: discoverGitBashExecutable(),
        run: (request) => new NativeProcessRunner(runnerPath).run(request),
      };
    } catch {
      return undefined;
    }
  }
  return new NativeProcessRunner(runnerPath);
}

class TuiModelRouter implements TuiAgentEngine {
  readonly #activeEngines = new Map<string, TuiAgentEngine>();

  public constructor(
    private readonly deepseek: TuiAgentEngine,
    private readonly minimax: TuiAgentEngine,
  ) {}

  public async *runTurn(
    input: PiAgentEngineInput,
    signal: AbortSignal,
  ): AsyncIterable<PiAgentObservation> {
    const engine = input.model === "MiniMax-M3" ? this.minimax : this.deepseek;
    this.#activeEngines.set(input.taskId, engine);
    try {
      yield* engine.runTurn(input, signal);
    } finally {
      if (this.#activeEngines.get(input.taskId) === engine)
        this.#activeEngines.delete(input.taskId);
    }
  }

  public steer(taskId: string, text: string): Promise<void> {
    const engine = this.#activeEngines.get(taskId);
    if (engine?.steer === undefined)
      return Promise.reject(new Error("Pi steering is unavailable."));
    return engine.steer(taskId, text);
  }

  public followUp(taskId: string, text: string): Promise<void> {
    const engine = this.#activeEngines.get(taskId);
    if (engine?.followUp === undefined)
      return Promise.reject(new Error("Pi follow-up is unavailable."));
    return engine.followUp(taskId, text);
  }
}

function parseModelId(value: string): CandyModelId | undefined {
  switch (value.toLowerCase()) {
    case "deepseek-flash":
    case "deepseek-v4-flash":
      return "deepseek-v4-flash";
    case "deepseek-pro":
    case "deepseek-v4-pro":
      return "deepseek-v4-pro";
    case "minimax-m3":
      return "MiniMax-M3";
    default:
      return undefined;
  }
}

function attachmentMimeType(
  filePath: string,
): "image/png" | "image/jpeg" | "image/gif" | "image/webp" {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      throw new Error("Unsupported image MIME type.");
  }
}

function isVideoAttachmentPath(filePath: string): boolean {
  return new Set([".avi", ".mkv", ".mov", ".mp4", ".webm"]).has(
    path.extname(filePath).toLowerCase(),
  );
}

function isPathInside(root: string, candidate: string): boolean {
  const normalize = (value: string): string =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const relative = path.relative(normalize(root), normalize(candidate));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function pathsOverlap(first: string, second: string): boolean {
  return isPathInside(first, second) || isPathInside(second, first);
}

function formatPaths(paths: readonly string[]): string {
  return paths.length === 0 ? "(none)" : paths.join(", ");
}

function sanitizeWorkspaceChanges(
  changes: WorkspaceChangeSnapshot,
  activeSecrets: readonly string[],
): WorkspaceChangeSnapshot {
  return {
    ...changes,
    tracked: changes.tracked.map((value) => redactSensitive(value, activeSecrets)),
    untracked: changes.untracked.map((value) => redactSensitive(value, activeSecrets)),
    patchText: redactSensitive(changes.patchText, activeSecrets),
  };
}

async function buildUntrackedReview(
  workspace: string,
  paths: readonly string[],
  activeSecrets: readonly string[],
): Promise<{
  readonly text: string;
  readonly fingerprint: string;
  readonly complete: boolean;
}> {
  const canonicalWorkspace = await realpath(workspace);
  const fingerprint = createHash("sha256");
  const sections: string[] = [];
  let complete = true;
  for (const requested of paths) {
    assertSafeDiffPath(requested);
    const absolute = path.resolve(workspace, requested);
    const source = await lstat(absolute);
    if (source.isSymbolicLink() || !source.isFile())
      throw new Error("Untracked review requires a regular non-symbolic file.");
    if (source.size > MAX_UNTRACKED_FILE_BYTES) {
      throw new ApplyChangesBlockedError(
        `Untracked file exceeds the ${MAX_UNTRACKED_FILE_BYTES}-byte review limit.`,
      );
    }
    const canonical = await realpath(absolute);
    if (!isPathInside(canonicalWorkspace, canonical))
      throw new Error("Untracked review path escapes the Task Workspace.");
    const content = await readFile(canonical);
    fingerprint.update(
      Buffer.from(`${Buffer.byteLength(requested, "utf8")}\0${requested}\0${content.length}\0`),
    );
    fingerprint.update(content);
    const safePath = redactSensitive(requested, activeSecrets);
    let text: string | undefined;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      text = undefined;
    }
    if (text === undefined) {
      complete = false;
      sections.push(`new binary file: ${safePath} (${content.length} bytes)`);
      continue;
    }
    const lines = redactSensitive(text, activeSecrets).split(/\r?\n/u);
    if (text.endsWith("\n") && lines.at(-1) === "") lines.pop();
    const added = lines.map((line) => `+${line}`).join("\n");
    sections.push(
      [
        `diff --git a/${safePath} b/${safePath}`,
        "new file",
        "--- /dev/null",
        `+++ b/${safePath}`,
        added,
      ].join("\n"),
    );
  }
  return { text: sections.join("\n"), fingerprint: fingerprint.digest("hex"), complete };
}

function sameWorkspaceChanges(
  left: WorkspaceChangeSnapshot,
  right: WorkspaceChangeSnapshot,
): boolean {
  return (
    left.available === right.available &&
    left.patchTruncated === right.patchTruncated &&
    left.patchText === right.patchText &&
    samePathList(left.tracked, right.tracked) &&
    samePathList(left.untracked, right.untracked)
  );
}

function samePathList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function extractRemovedPaths(patchText: string): readonly string[] {
  const removed: string[] = [];
  for (const section of patchText.split(/(?=^diff --git )/gmu)) {
    if (!section.startsWith("diff --git ") || !/^deleted file mode /mu.test(section)) continue;
    const header = section.split(/\r?\n/u, 1)[0] ?? "";
    const match = header.match(/^diff --git a\/(.+?) b\/(.+)$/u);
    const value = match?.[2] ?? match?.[1];
    if (value !== undefined) removed.push(value);
  }
  return [...new Set(removed)].sort();
}

function selectDiff(patchText: string, requestedPath: string): string {
  if (requestedPath === "") return patchText;
  if (!patchText.includes("diff --git ")) {
    return patchText
      .split(/\r?\n/u)
      .filter((line) => line.includes(requestedPath))
      .join("\n");
  }
  return patchText
    .split(/(?=^diff --git )/gmu)
    .filter((section) => {
      const header = section.split(/\r?\n/u, 1)[0] ?? "";
      return header.includes(`a/${requestedPath}`) || header.includes(`b/${requestedPath}`);
    })
    .join("");
}

function truncateTuiDiff(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_TUI_DIFF_BYTES) return value;
  const notice = `\n[diff truncated at ${MAX_TUI_DIFF_BYTES} bytes]\n`;
  const contentLimit = MAX_TUI_DIFF_BYTES - Buffer.byteLength(notice, "utf8");
  return `${Buffer.from(value, "utf8").subarray(0, contentLimit).toString("utf8")}${notice}`;
}

function truncateTuiTranscript(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_TUI_TRANSCRIPT_BYTES) return value;
  const notice = `\n[transcript truncated at ${MAX_TUI_TRANSCRIPT_BYTES} bytes]\n`;
  const contentLimit = MAX_TUI_TRANSCRIPT_BYTES - Buffer.byteLength(notice, "utf8");
  return `${Buffer.from(value, "utf8").subarray(0, contentLimit).toString("utf8")}${notice}`;
}

function assertSafeDiffPath(value: string): void {
  if (
    containsControlCharacter(value) ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.split(/[\\/]+/u).some((segment) => segment === "..")
  ) {
    throw new Error("Diff paths must be safe workspace-relative paths.");
  }
}

function isAbsoluteCommandPath(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function parseTuiPromptArguments(value: string): string[] | undefined {
  if (value.length === 0) return [];
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (quote !== undefined || escaped) return undefined;
  if (current.length > 0) args.push(current);
  return args;
}

function expandTuiPromptTemplate(
  template: CandyPromptTemplateInfo,
  args: readonly string[],
): string {
  const allArguments = args.join(" ");
  return template.content
    .replace(/\$(\d{1,2})(?!\d)/gu, (_match: string, number: string) => {
      return args[Number(number) - 1] ?? "";
    })
    .replace(/\$(?:ARGUMENTS|@)/gu, allArguments);
}

function redactSensitive(value: string, activeSecrets: readonly string[]): string {
  return activeSecrets.reduce(
    (result, secret) => (secret.length === 0 ? result : result.split(secret).join("[REDACTED]")),
    redactTuiOutput(value),
  );
}

function boundedToolName(value: string, activeSecrets: readonly string[]): string {
  const redacted = redactSensitive(value, activeSecrets).replace(/[\r\n\t]/gu, " ");
  return redacted.length <= 128 ? redacted : `${redacted.slice(0, 128)}…`;
}

function boundedToolDetail(
  value: string | undefined,
  activeSecrets: readonly string[],
): string | undefined {
  if (value === undefined) return undefined;
  const redacted = replaceToolControlCharacters(redactSensitive(value, activeSecrets));
  return redacted.length <= 2_048 ? redacted : `${redacted.slice(0, 2_048)}…`;
}

function replaceToolControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("");
}

function safeError(error: unknown): string {
  if (error instanceof ProviderContractError) return safeProviderError(error);
  if (error instanceof ApplyChangesBlockedError) return error.message;
  if (
    error instanceof Error &&
    /credentials|cancelled|unavailable|attachment|image|workspace|worktree|review|completed|ownership|applied|symbolic|MIME|video|model|active turn|queued/iu.test(
      error.message,
    )
  )
    return error.message;
  return "runtime error";
}

function safeProviderError(error: ProviderContractError): string {
  if (error.code === "needs_credentials") return "provider credentials are unavailable";
  if (error.code === "unapproved_endpoint") return "provider endpoint is not approved";
  if (error.code === "malformed_stream") return "provider response was malformed";
  switch (error.reason) {
    case "unauthorized":
      return "provider rejected the credential";
    case "rate_limited":
      return "provider rate limit reached";
    case "timeout":
      return "provider request timed out";
    case "network_error":
      return "provider network request failed";
    case "http_error":
      return "provider request failed";
    default:
      return "provider request failed";
  }
}

function parseCredentialName(value: string | undefined): CredentialName | undefined {
  if (value === "deepseek") return "deepseek";
  if (value === "minimax" || value === "minimax-cn") return "minimax-cn";
  return undefined;
}

function credentialStoreError(error: unknown): string {
  if (error instanceof Error && /already exists|invalid/u.test(error.message)) return error.message;
  return "OS credential store unavailable";
}

function resolveActiveTuiProviderSecrets(
  environment: NodeJS.ProcessEnv,
  store: CredentialStore,
): readonly string[] {
  const leases: NonNullable<ReturnType<typeof resolveCredential>>[] = [];
  for (const provider of ["deepseek", "minimax-cn"] as const) {
    try {
      const lease = resolveCredential(provider, environment, store);
      if (lease !== undefined) leases.push(lease);
    } catch {
      // Presence is optional; the provider path reports needs_credentials when used.
    }
  }
  try {
    return leases.map((lease) => lease.value);
  } finally {
    for (const lease of leases) lease.release();
  }
}

function containsAnyActiveSecret(content: Uint8Array, activeSecrets: readonly string[]): boolean {
  const bytes = Buffer.from(content);
  return activeSecrets.some(
    (secret) => secret.length > 0 && bytes.includes(Buffer.from(secret, "utf8")),
  );
}

function isTuiOwnerAlive(ownerId: string): boolean {
  if (activeTuiOwners.has(ownerId)) return true;
  const match = /^tui:(\d+)(?::[0-9a-f-]+)?$/u.exec(ownerId);
  if (match === null) return true;
  const pid = Number(match[1]);
  if (pid === process.pid) return false;
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  return isProcessAlive(pid);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function redactTuiOutput(value: string): string {
  return replaceTuiControlSequences(redactCredentialMaterial(value));
}

function replaceTuiControlSequences(value: string): string {
  const characters = [...value];
  const output: string[] = [];
  const escape = String.fromCodePoint(0x1b);
  const bell = String.fromCodePoint(0x07);
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (character === undefined) break;
    const codePoint = character.codePointAt(0) ?? 0;
    if (character !== escape) {
      output.push(isTuiNonNewlineControl(codePoint) ? " " : character);
      continue;
    }
    const next = characters[index + 1];
    if (next === "]") {
      output.push(" ");
      index += 2;
      while (index < characters.length) {
        if (characters[index] === bell) break;
        if (characters[index] === escape && characters[index + 1] === "\\") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (next === "[") {
      output.push(" ");
      index += 2;
      while (index < characters.length) {
        const sequenceCharacter = characters[index];
        if (sequenceCharacter === undefined) break;
        const sequenceCodePoint = sequenceCharacter.codePointAt(0) ?? 0;
        if (sequenceCodePoint >= 0x40 && sequenceCodePoint <= 0x7e) break;
        index += 1;
      }
      continue;
    }
    output.push(" ");
    if (next !== undefined) index += 1;
  }
  return output.join("");
}

function isTuiNonNewlineControl(codePoint: number): boolean {
  return (
    codePoint <= 0x09 ||
    (codePoint >= 0x0b && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f)
  );
}

function formatApprovalField(value: string): string {
  return JSON.stringify(value);
}

function transcriptText(value: string): string {
  return redactTuiOutput(value).slice(0, 4_096);
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href
  );
}

if (isDirectExecution()) {
  if (process.argv.includes("--smoke-task")) console.log(JSON.stringify(await runTuiTaskSmoke()));
  else if (process.argv.includes("--smoke")) console.log(JSON.stringify(await runTuiSmoke()));
  else await createDefaultInteractiveTui().run();
}
