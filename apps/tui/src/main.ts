import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PI_COMPATIBILITY_VERSION,
  CustomPiAgentEngine,
  MiniMaxPiAgentEngine,
  PiAgentEngine,
  ProviderContractError,
  type CandyNetworkApprovalRequest,
  type CandyPromptTemplateInfo,
  loadCandyModelConfigSync,
  loadCandyResourceDiagnostics,
  loadCandyPromptTemplates,
  loadCandySkillContent,
  loadCandySkillInfos,
  resolveCandySkillRoots,
  type ConfiguredModelEntry,
  type PiAgentEngineInput,
  type PiAgentObservation,
  type PiToolFailure,
  listPiPublicExports,
} from "@candy/pi-adapter";
import {
  type CandyModelId,
  type ClipboardImage,
  containsCredentialMaterial,
  copyToClipboard,
  type CredentialName,
  type CredentialStore,
  DEFAULT_CANDY_MODEL,
  isValidCredentialName,
  KeyringCredentialStore,
  NativeProcessRunner,
  type NativeProcessRequest,
  type NativeProcessResult,
  resolveAppPaths,
  readClipboardImage,
  resolveCredential,
  resolveCredentialEnvKey,
  resolveDefaultAppDataRoot,
  resolveNativeProcessRunnerPath,
  redactCredentialMaterial,
  deriveTaskTitle,
  SQLiteTaskStore,
  SystemClock,
  type TaskMetadata,
  type TaskReviewMetadata,
  type PersistedRunStopReason,
  discoverGitBashExecutable,
  getWindowsTrustedShellCapabilityStatus,
  isVisionCapableModel,
  isTrustedShellAutoAvailable as isPlatformTrustedShellAutoAvailable,
} from "@candy/platform";
import {
  ApplyChangesBlockedError,
  ApplyChangesService,
  AttachmentStore,
  captureWorkspaceFileSnapshots,
  restoreWorkspaceFileSnapshots,
  CommandValidator,
  CandyRuntime,
  DeterministicAgentEngine,
  GitWorktreeManager,
  GitWorkspaceChangeTracker,
  isGitWorkspaceClean,
  NonGitWorkspaceChangeTracker,
  ResolvedWorkspaceChangeTracker,
  MAX_ATTACHMENT_BYTES,
  MAX_UNTRACKED_FILE_BYTES,
  LongRunningTaskRunner,
  TaskController,
  TaskScheduler,
  UnavailableBrowserCapability,
  type CommandValidatorCommand,
  type GitWorktreePlan,
  type ValidatorResult,
  type WorkspaceChangeSnapshot,
  type WorkspaceChangeTracker,
  type WorkspaceFileSnapshot,
  linkTaskWorktreeDependencies,
  planGitWorktree,
  resolveGitCommonDirectory,
  resolveTaskWorktreeDependencyDirectory,
  resolveWorkspaceDependencyDirectory,
  resolveTaskWorktreeRoot,
} from "@candy/runtime";
import { CandyTuiSurface, type CandyTuiTerminal } from "./pi-tui-surface.js";
import { expandWorkspaceMentionPrompt } from "./file-mentions.js";
import {
  CANDY_MODEL_CHOICES,
  CANDY_SLASH_COMMANDS,
  isCandySkillSlashCommandName,
} from "./slash-commands.js";

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
  readonly worktreeEnabled?: boolean;
  /** Set only by a composition root after the platform-specific G2 gate passes. */
  readonly trustedShellAutoAvailable?: boolean;
  /** Set only by a composition root for the macOS Full access Personal Preview. */
  readonly fullAccessAvailable?: boolean;
  /** Test seam; the production default copies through the platform adapter. */
  readonly copyToClipboardImpl?: (text: string) => Promise<void>;
  /** Test seam; production reads an image only after the Ctrl+V gesture. */
  readonly readClipboardImageImpl?: () => Promise<ClipboardImage | undefined>;
  /** Test seam; the production default resolves the platform skill roots. */
  readonly skillRoots?: readonly string[];
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

const MACOS_FULL_ACCESS_PREVIEW_ATTESTATION = Object.freeze({
  // Full access is intentionally a separate, source-bound macOS preview gate.
  // It must not be enabled by an environment variable or a TUI input alone.
  approved: true,
  platform: "darwin",
  architecture: "arm64",
  nativeBackend: "supervised-full-access-v1",
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

export function isMacosFullAccessAvailable(): boolean {
  return (
    MACOS_FULL_ACCESS_PREVIEW_ATTESTATION.approved &&
    process.platform === MACOS_FULL_ACCESS_PREVIEW_ATTESTATION.platform &&
    process.arch === MACOS_FULL_ACCESS_PREVIEW_ATTESTATION.architecture
  );
}

function isTrustedShellAutoAvailableOnHost(): boolean {
  return isPlatformTrustedShellAutoAvailable() || isMacosTrustedShellAutoAvailable();
}

export type TuiCompositionRootOptions = Omit<
  InteractiveTuiOptions,
  "trustedShellAutoAvailable" | "fullAccessAvailable"
>;

/**
 * Normal TUI composition root. New interactive tasks default to isolation so
 * the common local-development path is ready without a toggle. Callers can
 * still explicitly opt out for a test seam or a deliberate direct-mode use.
 * InteractiveTui itself remains safe by default for tests and non-TUI
 * embedders.
 */
export function createDefaultInteractiveTui(
  options: TuiCompositionRootOptions = {},
): InteractiveTui {
  return new InteractiveTui({
    ...options,
    worktreeEnabled: options.worktreeEnabled ?? true,
    trustedShellAutoAvailable: isTrustedShellAutoAvailableOnHost(),
    fullAccessAvailable: isMacosFullAccessAvailable(),
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

/**
 * Read-only planning instruction prepended to the user's goal by `/plan`.
 * The planning turn always runs with the read-only profile, so Candy's
 * workspace mutation tools are never registered for it.
 */
const PLAN_TURN_INSTRUCTION =
  "[PLAN-MODE] This is a read-only planning turn: analyze the repository; do not modify, create, or delete files; do not run commands. Produce a concrete plan: goal, files involved, steps, risks, verification.\n";

/**
 * Explicit continuation prompt used by `/build`. The task's Pi session
 * already contains the reviewed plan, so the goal is not replayed; this
 * instruction only unlocks implementation with the current profile.
 */
const BUILD_TURN_INSTRUCTION =
  "[BUILD-PHASE] The read-only plan was reviewed by the user. Implement it now: workspace mutations are allowed. Explain adjustments when code diverges from the plan.\n";

/**
 * Auto Debug loop bounds. The loop runs bounded rounds and stops early when
 * the validator passes, the evidence stalls, or the user cancels; an
 * exhausted budget leaves the task interrupted (explicit continuation only).
 */
const MAX_DEBUG_ROUNDS = 6;

/**
 * Goal banner for `/debug`. Each failing round appends the bounded validator
 * evidence to the next turn's prompt so the model repairs its own change.
 */
const DEBUG_TURN_INSTRUCTION =
  "[AUTO-DEBUG] Make the change and verify it with the configured validator. After each of your turns the validator runs automatically; when it fails, the next turn receives the bounded failure evidence and you must fix the root cause. Keep changes minimal and do not remove unrelated work.\n";

/** Per-task in-memory undo history bound (most recent N turn checkpoints). */
const MAX_UNDO_TURNS = 8;
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
  readonly #copyToClipboardImpl: (text: string) => Promise<void>;
  readonly #readClipboardImageImpl: () => Promise<ClipboardImage | undefined>;
  readonly #activeSecretsProvider: (() => readonly string[]) | undefined;
  readonly #credentialStore: CredentialStore;
  readonly #credentialEnvironment: NodeJS.ProcessEnv;
  readonly #shellRunner: TuiShellRunner | undefined;
  readonly #trustedShellAutoAvailable: boolean;
  readonly #fullAccessAvailable: boolean;
  readonly #controllers = new Map<string, TaskController>();
  readonly #abortControllers = new Map<string, AbortController>();
  readonly #taskRuns = new Map<string, Promise<void>>();
  readonly #validatorAbortControllers = new Map<string, AbortController>();
  readonly #validatorRuns = new Map<string, Promise<void>>();
  readonly #ownerWatchers = new Map<string, ReturnType<typeof setInterval>>();
  readonly #validatorStops = new Map<string, "cancelled" | "timeout">();
  readonly #validatorStates = new Map<string, TuiValidatorState>();
  readonly #taskPhases = new Map<string, string>();
  readonly #workspaceReviews = new Map<string, TuiWorkspaceReview>();
  readonly #requestedStops = new Map<string, "paused" | "cancelled" | "interrupted">();
  readonly #networkApprovals = new Map<
    string,
    {
      readonly taskId: string;
      readonly summary: string;
      readonly settle: (approved: boolean) => void;
    }
  >();
  readonly #engine: TuiAgentEngine;
  readonly #ownerId = `tui:${process.pid}:${randomUUID()}`;
  readonly #skillRoots: readonly string[];
  #currentTaskId: string | undefined;
  #surface: CandyTuiSurface | undefined = undefined;
  #resolveExit: (() => void) | undefined = undefined;
  #closing = false;
  #creatingTask = false;
  #pendingTaskCreation: Promise<void> | undefined;
  /** Bare `/plan` sets this so the next prompt creates a read-only plan task. */
  #planPending = false;
  /** Bare `/debug` sets this so the next prompt creates an Auto Debug task. */
  #debugPending = false;
  /** Per-task undo history: most recent checkpoint last, bounded to 8 turns. */
  #undoHistory = new Map<string, readonly (readonly WorkspaceFileSnapshot[])[]>();
  #approvalProfile: "read-only" | "auto" = "auto";
  #worktreeEnabled = false;
  #selectedModel: CandyModelId = DEFAULT_CANDY_MODEL;
  #selectedAttachmentIds: string[] = [];
  #trustedShellEnabled = false;
  /** An explicit opt-out overrides the macOS default for subsequent tasks. */
  #trustedShellDisabled = false;
  /** Persisted macOS Full access default, selected after one explicit warning. */
  #fullAccessEnabled = false;
  /** The warning must be viewed in this TUI process before a confirmation takes effect. */
  #fullAccessConfirmationPending = false;
  /** Git push authorization for new tasks; 'allow' must be set by the user. */
  #pushPolicy: "deny" | "allow" = "deny";
  /** User-configured OpenAI-compatible models from the Candy-owned models.json. */
  #configuredModels: readonly ConfiguredModelEntry[] = [];
  #modelConfigDiagnostics: readonly string[] = [];
  #validatorCommand: CommandValidatorCommand | undefined;
  /** Contiguous assistant text of the current stream; flushed into the last reply on plain writes. */
  #assistantBuffer = "";
  /** Last complete contiguous assistant reply for Ctrl+X copy. */
  #lastAssistantReply = "";
  #inAssistantRun = false;

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
    this.#worktreeEnabled = options.worktreeEnabled ?? false;
    this.#changeTracker =
      options.changeTracker ??
      new ResolvedWorkspaceChangeTracker(
        new GitWorkspaceChangeTracker(),
        new NonGitWorkspaceChangeTracker(),
      );
    this.#validator = options.validator ?? createNativeTuiValidator();
    this.#validatorTimeoutMs = options.validatorTimeoutMs ?? DEFAULT_VALIDATOR_TIMEOUT_MS;
    this.#copyToClipboardImpl = options.copyToClipboardImpl ?? copyToClipboard;
    this.#readClipboardImageImpl = options.readClipboardImageImpl ?? readClipboardImage;
    this.#shellRunner = options.shellRunner ?? createNativeTuiShellRunner();
    this.#trustedShellAutoAvailable = options.trustedShellAutoAvailable ?? false;
    this.#fullAccessAvailable = options.fullAccessAvailable ?? false;
    this.#fullAccessEnabled = this.fullAccessAvailable() && this.#store.fullAccessDefaultEnabled();
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
    const modelConfig = loadCandyModelConfigSync(paths.root);
    this.#configuredModels = modelConfig.entries;
    this.#modelConfigDiagnostics = modelConfig.diagnostics.map((diagnostic) => diagnostic.message);
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
          if (lease === undefined) return undefined;
          const value = lease.value;
          return { secret: value, release: lease.release };
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
          if (lease === undefined) return undefined;
          const value = lease.value;
          return { secret: value, release: lease.release };
        },
        this.#shellRunner,
      );
      const customEngines = new Map<string, TuiAgentEngine>();
      for (const entry of this.#configuredModels) {
        const engine = new CustomPiAgentEngine(
          paths.sessions,
          async () => {
            const lease = resolveCredential(
              entry.credentialName,
              this.#credentialEnvironment,
              this.#credentialStore,
            );
            if (lease === undefined) return undefined;
            const value = lease.value;
            return { secret: value, release: lease.release };
          },
          entry,
          this.#shellRunner,
        );
        customEngines.set(entry.id, engine);
      }
      this.#engine = new TuiModelRouter(deepseek, minimax, customEngines);
    }
    this.#skillRoots = options.skillRoots ?? resolveCandySkillRoots(process.env);
  }

  public async run(): Promise<void> {
    const skills = loadCandySkillInfos(
      this.#appDataRoot,
      this.activeSecretsSnapshot(),
      this.#skillRoots,
    ).skills.map((skill) => ({ name: skill.name, description: skill.description }));
    this.#surface = new CandyTuiSurface({
      appDataRoot: this.#appDataRoot,
      workspacePath: () => this.#workspacePath,
      model: () => this.#selectedModel,
      profile: () => this.#approvalProfile,
      worktreeEnabled: () => this.#worktreeEnabled,
      trustedShellEnabled: () => this.localCommandsEnabled(),
      fullAccessEnabled: () => this.fullAccessEnabled(),
      fullAccessAvailable: () => this.fullAccessAvailable(),
      fullAccessConfirmationPending: () => this.#fullAccessConfirmationPending,
      taskId: () => this.#currentTaskId,
      taskTitle: () =>
        this.#currentTaskId === undefined ? undefined : this.#store.get(this.#currentTaskId)?.title,
      taskPhase: () =>
        this.#currentTaskId === undefined ? undefined : this.#taskPhases.get(this.#currentTaskId),
      assistantReplyAvailable: () =>
        this.#lastAssistantReply.trim().length > 0 || this.#assistantBuffer.trim().length > 0,
      recoveryTaskCount: () =>
        this.#store.list().filter((task) => task.state === "paused" || task.state === "interrupted")
          .length,
      skills,
      modelChoices: [
        ...CANDY_MODEL_CHOICES,
        ...this.#configuredModels.map((entry) => ({
          value: entry.id,
          label: entry.id,
          description: `${entry.label} (user-configured)`,
        })),
      ],
      terminal: this.#terminal,
      onSubmit: (text: string): void => {
        try {
          this.handleInput(text);
        } catch (error) {
          this.write(`input rejected: ${safeError(error)}\n`);
        }
      },
      onInterrupt: (): void => this.requestExit(),
      onCopyLastAssistant: (): void => this.copyLastAssistant(),
      onOpenFullAccess: (): void => this.setAccess("full"),
      onConfirmFullAccess: (): void => this.setAccess("full confirm"),
      onPasteImage: (): void => this.pasteImageFromClipboard(),
      onCycleModel: (direction: 1 | -1): void => this.cycleModel(direction),
    });
    const exitPromise: Promise<void> = new Promise<void>((resolve: () => void): void => {
      this.#resolveExit = resolve;
    });
    for (const diagnostic of this.#modelConfigDiagnostics) {
      this.write(`models.json warning: ${diagnostic}\n`);
    }
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
    const raw: string = value.trim();
    const trimmed: string = raw.startsWith(":") ? `/${raw.slice(1)}` : raw;
    if (trimmed === "/quit") {
      this.requestExit();
    } else if (trimmed === "/help") {
      this.showHelp();
    } else if (trimmed === "/status" || trimmed.startsWith("/status ")) {
      this.showStatus(trimmed.slice(7).trim());
    } else if (this.#creatingTask) {
      this.write("task creation in progress; wait for the queued-task result\n");
    } else if (trimmed === "/new" || trimmed.startsWith("/new ")) {
      this.newTask(trimmed.slice(4).trim());
    } else if (trimmed === "/plan" || trimmed.startsWith("/plan ")) {
      this.planTask(trimmed.slice(5).trim());
    } else if (trimmed === "/build" || trimmed.startsWith("/build ")) {
      this.buildTask(trimmed.slice(6).trim());
    } else if (trimmed === "/debug" || trimmed.startsWith("/debug ")) {
      this.debugTask(trimmed.slice(6).trim());
    } else if (trimmed === "/undo" || trimmed.startsWith("/undo ")) {
      this.undoTask(trimmed.slice(6).trim());
    } else if (trimmed === "/checkpoints") {
      this.showCheckpoints();
    } else if (trimmed === "/use") {
      this.printTasks();
      this.write("choose with /use <task-id>\n");
    } else if (trimmed.startsWith("/use ")) {
      this.useTask(trimmed.slice(5).trim());
    } else if (trimmed === "/workspace" || trimmed.startsWith("/workspace ")) {
      void this.configureWorkspace(trimmed.slice(10).trim()).catch((error: unknown) => {
        this.write(`workspace rejected: ${safeError(error)}\n`);
      });
    } else if (trimmed === "/transcript" || trimmed.startsWith("/transcript ")) {
      this.showTranscript(trimmed.slice(11).trim());
    } else if (trimmed === "/resources") {
      this.showResourceDiagnostics();
    } else if (trimmed === "/skills") {
      this.listSkills();
    } else if (trimmed === "/skill" || trimmed.startsWith("/skill ")) {
      this.invokeSkill(trimmed.slice(6).trim());
    } else if (trimmed === "/prompts") {
      this.listPromptTemplates();
    } else if (trimmed === "/prompt" || trimmed.startsWith("/prompt ")) {
      this.invokePromptTemplate(trimmed.slice(7).trim());
    } else if (trimmed === "/credentials" || trimmed === "/credential") {
      this.showCredentials();
    } else if (trimmed.startsWith("/credential ")) {
      this.configureCredential(trimmed.slice(12).trim());
    } else if (trimmed === "/model" || trimmed.startsWith("/model ")) {
      this.configureModel(trimmed.slice(6).trim());
    } else if (trimmed === "/attach" || trimmed.startsWith("/attach ")) {
      void this.attachPath(trimmed.slice(7).trim()).catch((error: unknown) => {
        this.write(`attachment rejected: ${safeError(error)}\n`);
      });
    } else if (trimmed === "/attachments") {
      void this.showAttachments().catch((error: unknown) => {
        this.write(`attachments unavailable: ${safeError(error)}\n`);
      });
    } else if (trimmed === "/tasks") {
      this.printTasks();
    } else if (trimmed === "/access" || trimmed.startsWith("/access ")) {
      this.setAccess(trimmed.slice(7).trim());
    } else if (trimmed === "/profile") {
      this.write(`profile: ${this.#approvalProfile}\n`);
    } else if (trimmed.startsWith("/profile ")) {
      this.setProfile(trimmed.slice(9).trim());
    } else if (trimmed === "/worktree" || trimmed.startsWith("/worktree ")) {
      this.setWorktree(trimmed.slice(9).trim());
    } else if (trimmed === "/local" || trimmed.startsWith("/local ")) {
      this.setLocalCommands(trimmed.slice(6).trim());
    } else if (trimmed === "/trusted-shell" || trimmed.startsWith("/trusted-shell ")) {
      this.setLocalCommands(trimmed.slice(14).trim());
    } else if (trimmed === "/shell" || trimmed.startsWith("/shell ")) {
      this.setLocalCommands(trimmed.slice(6).trim());
    } else if (trimmed === "/validator" || trimmed.startsWith("/validator ")) {
      this.configureValidator(trimmed.slice(10).trim());
    } else if (trimmed === "/push" || trimmed.startsWith("/push ")) {
      this.configurePushPolicy(trimmed.slice(5).trim());
    } else if (trimmed === "/changes") {
      void this.showChanges().catch((error: unknown) => {
        this.write(`changes rejected: ${safeError(error)}\n`);
      });
    } else if (trimmed === "/diff" || trimmed.startsWith("/diff ")) {
      void this.showDiff(trimmed.slice(5).trim()).catch((error: unknown) => {
        this.write(`diff rejected: ${safeError(error)}\n`);
      });
    } else if (trimmed === "/apply") {
      void this.applyCurrent().catch((error: unknown) => {
        this.write(`apply blocked: ${safeError(error)}\n`);
      });
    } else if (trimmed === "/discard") {
      void this.discardCurrent().catch((error: unknown) => {
        this.write(`discard blocked: ${safeError(error)}\n`);
      });
    } else if (trimmed === "/validate") {
      this.validateCurrent();
    } else if (trimmed.startsWith("/approve ")) {
      this.resolveApproval(trimmed.slice(9).trim(), true);
    } else if (trimmed.startsWith("/deny ")) {
      this.resolveApproval(trimmed.slice(6).trim(), false);
    } else if (trimmed.startsWith("/prioritize ")) {
      this.prioritize(trimmed.slice(12).trim());
    } else if (trimmed.startsWith("/pause ")) {
      this.pause(trimmed.slice(7).trim());
    } else if (trimmed === "/resume") {
      this.showResumableTasks();
    } else if (trimmed.startsWith("/resume ")) {
      const resumeValue = trimmed.slice(8).trim();
      const separator = resumeValue.indexOf(" ");
      this.resume(
        separator < 0 ? resumeValue : resumeValue.slice(0, separator),
        separator < 0 ? undefined : resumeValue.slice(separator + 1).trim(),
      );
    } else if (trimmed.startsWith("/steer ")) {
      void this.queueActiveTurnMessage("steer", trimmed.slice(7).trim());
    } else if (trimmed.startsWith("/follow-up ")) {
      void this.queueActiveTurnMessage("followUp", trimmed.slice(11).trim());
    } else if (trimmed.startsWith("/cancel ")) {
      void this.cancel(trimmed.slice(8).trim()).catch((error: unknown) => {
        this.write(`cancel rejected: ${safeError(error)}\n`);
      });
    } else if (raw.length > 0) {
      if (trimmed.startsWith("/")) {
        const name = trimmed.slice(1).split(/\s+/u, 1)[0] ?? "";
        const command = CANDY_SLASH_COMMANDS.find((entry) => entry.name === name);
        if (command !== undefined && command.requiredArgument === true) {
          this.write(
            `usage: ${command.usage ?? `/${command.name} ${command.argumentHint ?? "<required>"}`}\n`,
          );
          return;
        }
        if (
          isCandySkillSlashCommandName(name) &&
          loadCandySkillInfos(
            this.#appDataRoot,
            this.activeSecretsSnapshot(),
            this.#skillRoots,
          ).skills.some((skill) => skill.name === name)
        ) {
          this.invokeSkill(trimmed.slice(1));
          return;
        }
      }
      this.submitPrompt(raw);
    }
  }

  private requestExit(): void {
    this.#resolveExit?.();
  }

  private create(
    prompt: string,
    validatorOverride?: CommandValidatorCommand,
    planMode = false,
    taskMode: "build" | "debug" = "build",
  ): void {
    if (this.#creatingTask) {
      this.write("task creation in progress; wait for the queued-task result\n");
      return;
    }
    const effectivePlanMode = planMode || this.#planPending;
    const effectiveTaskMode: "build" | "debug" =
      taskMode === "debug" || this.#debugPending ? "debug" : "build";
    this.#planPending = false;
    this.#debugPending = false;
    this.#creatingTask = true;
    const operation = this.createTask(
      prompt,
      validatorOverride,
      effectivePlanMode,
      effectiveTaskMode,
    );
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

  private async createTask(
    prompt: string,
    validatorOverride?: CommandValidatorCommand,
    planMode = false,
    taskMode: "build" | "debug" = "build",
  ): Promise<void> {
    if (containsCredentialMaterial(prompt) || this.hasActiveProviderSecret(prompt)) {
      this.write("prompt rejected: credential-shaped content is forbidden\n");
      return;
    }
    if (this.#selectedAttachmentIds.length > 0 && !isVisionCapableModel(this.#selectedModel)) {
      this.write(
        "image attachments require explicit /model minimax-m3 or /model deepseek-flash-vision; switch models before creating the task\n",
      );
      return;
    }
    const taskId = `task-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const queueOrder =
      this.#store.queued().reduce((max, task) => Math.max(max, task.queueOrder ?? 0), 0) + 1;
    const workspacePath = this.#workspacePath;
    // Plan tasks always start read-only: the planning turn must never mutate.
    // `/build` promotes the reviewed task to the current TUI profile later.
    const approvalProfile = planMode ? "read-only" : this.#approvalProfile;
    const selectedModel = this.#selectedModel;
    const attachmentIds = [...this.#selectedAttachmentIds];
    const validatorCommand = validatorOverride ?? this.#validatorCommand;
    const title = deriveTaskTitle(prompt);
    const effectivePrompt = planMode
      ? `${PLAN_TURN_INSTRUCTION}${prompt}`
      : taskMode === "debug"
        ? `${DEBUG_TURN_INSTRUCTION}${prompt}`
        : prompt;
    if (taskMode === "debug" && validatorCommand === undefined) {
      this.write(
        "Auto Debug requires a validator: configure one with /validator <executable> [args] or pass --validator\n",
      );
      return;
    }
    this.write(`preparing ${taskId} in ${workspacePath}\n`);
    const workspaceBaseline = await this.#changeTracker.captureBaseline(workspacePath);
    const sourceWorkspaceDirty =
      approvalProfile === "auto" && workspaceBaseline !== undefined && this.#worktreeEnabled
        ? !(await isGitWorkspaceClean(workspacePath))
        : false;
    const fullAccess = !planMode && approvalProfile === "auto" && this.fullAccessEnabled();
    const trustedShell =
      !planMode &&
      approvalProfile === "auto" &&
      workspaceBaseline !== undefined &&
      (fullAccess || this.localCommandsEnabled());
    if (fullAccess) {
      if (!this.fullAccessAvailable())
        throw new Error("Full access is unavailable on this macOS installation.");
      if (this.#shellRunner === undefined)
        throw new Error("Full access requires the Native Sandbox Runner installation.");
      if (workspaceBaseline === undefined) throw new Error("Full access requires a Git workspace.");
    }
    if (trustedShell && !fullAccess) {
      if (!this.#trustedShellAutoAvailable || !isTrustedShellAutoAvailableOnHost())
        throw new Error("Local commands are unavailable on this platform.");
      if (approvalProfile !== "auto") throw new Error("Local commands require the Auto profile.");
      if (this.#shellRunner === undefined)
        throw new Error("Local commands are unavailable in this installation.");
      if (workspaceBaseline === undefined)
        throw new Error("Local commands require a Git workspace.");
    }
    if (approvalProfile === "auto" && workspaceBaseline !== undefined && !this.#worktreeEnabled) {
      const directTaskActive = this.#store
        .list()
        .some(
          (task) =>
            task.workspacePath === workspacePath &&
            task.approvalProfile === "auto" &&
            task.worktreePath === undefined &&
            (task.state === "queued" ||
              task.state === "running" ||
              task.state === "waiting_approval" ||
              task.state === "paused"),
        );
      if (directTaskActive)
        throw new Error(
          "A direct-mode task is already active in this workspace; finish or cancel it first.",
        );
    }
    let worktreePath: string | undefined;
    let dependencyDirectory: string | undefined;
    if (approvalProfile === "auto" && workspaceBaseline !== undefined && this.#worktreeEnabled) {
      const plan = this.planForTask(taskId, workspacePath, workspaceBaseline);
      try {
        await this.#worktreeManager.create(plan);
        dependencyDirectory = await linkTaskWorktreeDependencies(
          workspacePath,
          plan.worktreePath,
        ).catch(() => undefined);
      } catch (error) {
        throw new Error("Task Worktree creation failed.", { cause: error });
      }
      worktreePath = plan.worktreePath;
    }
    if (trustedShell && worktreePath === undefined)
      dependencyDirectory = await resolveWorkspaceDependencyDirectory(workspacePath);
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
        title,
        taskMode,
        fullAccess,
        this.#pushPolicy,
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
    if (planMode) {
      this.write(`plan mode: read-only analysis; after reviewing the plan run /build ${taskId}\n`);
    }
    if (taskMode === "debug") {
      this.write(
        `debug mode: bounded Auto Debug loop (max ${MAX_DEBUG_ROUNDS} rounds); /cancel ${taskId} to stop\n`,
      );
    }
    if (sourceWorkspaceDirty) {
      this.write(
        "本地工作区有未提交修改：此安全任务从最新提交开始，不包含这些修改；如需基于它们工作，请取消或丢弃本任务后使用 /access current 新建任务\n",
      );
    }
    if (trustedShell && !fullAccess) {
      const explicitlyEnabled = this.#trustedShellEnabled;
      this.#trustedShellEnabled = false;
      if (explicitlyEnabled)
        this.write(
          "Local commands enabled for this task: offline commands run automatically; network requires one-command approval\n",
        );
      this.write(
        dependencyDirectory === undefined
          ? `本地检查已就绪：${worktreePath === undefined ? "当前工作区" : "安全工作区"} · 无网络；未检测到可复用的 node_modules，不会自动下载\n`
          : `本地检查已就绪：${worktreePath === undefined ? "当前工作区" : "安全工作区"} · 复用本地依赖 · 无网络${worktreePath === undefined ? "；网络命令不开放" : "；网络操作仍需逐条确认"}\n`,
      );
    }
    if (fullAccess) {
      this.write(
        "Full access enabled by default for this macOS task: local commands run with broad filesystem and network access; provider credentials are removed from the child environment, and commit, push, publish, release, and deploy remain protected. Use /access safe to return to the default sandbox\n",
      );
    }
    if (!this.#closing) this.drain(new Map([[taskId, effectivePrompt]]));
  }

  private planTask(value: string): void {
    const parsed = parseNewTaskInput(value);
    if (parsed === undefined) {
      this.write(
        "usage: /plan [prompt] or /plan --validator <absolute-executable> [args] -- <goal>\n",
      );
      return;
    }
    this.#currentTaskId = undefined;
    this.#debugPending = false;
    if (parsed.prompt.length === 0) {
      this.#planPending = true;
      this.write("plan task ready; enter a prompt\n");
      return;
    }
    this.create(parsed.prompt, parsed.validator, true);
  }

  private debugTask(value: string): void {
    const parsed = parseNewTaskInput(value);
    if (parsed === undefined) {
      this.write(
        "usage: /debug [prompt] or /debug --validator <absolute-executable> [args] -- <goal>\n",
      );
      return;
    }
    const validatorCommand = parsed.validator ?? this.#validatorCommand;
    if (validatorCommand === undefined) {
      this.write(
        "Auto Debug requires a validator: configure one with /validator <executable> [args] or pass --validator\n",
      );
      return;
    }
    this.#currentTaskId = undefined;
    this.#planPending = false;
    if (parsed.prompt.length === 0) {
      this.#debugPending = true;
      this.write("debug task ready; enter a prompt\n");
      return;
    }
    this.create(parsed.prompt, validatorCommand, false, "debug");
  }

  /**
   * Promote a reviewed read-only plan task to the current TUI profile and
   * queue one explicit implementation turn. The Pi session already holds the
   * plan, so only the build instruction is sent as the continuation.
   */
  private buildTask(value: string): void {
    const requested = value.trim();
    const controller =
      requested.length === 0 ? this.currentTask() : this.ensureController(requested);
    if (controller === undefined) {
      this.write(
        requested.length === 0
          ? "no current task; create a plan task with /plan <prompt> first\n"
          : `task ${requested} does not exist\n`,
      );
      return;
    }
    const snapshot = controller.snapshot();
    const metadata = this.#store.get(snapshot.taskId);
    if (metadata === undefined) {
      this.write(`task ${snapshot.taskId} metadata is unavailable\n`);
      return;
    }
    if (
      snapshot.state === "running" ||
      snapshot.state === "waiting_approval" ||
      snapshot.state === "queued"
    ) {
      this.write(
        `task ${snapshot.taskId} has an active or queued turn; run /build after the plan turn completes\n`,
      );
      return;
    }
    if (metadata.approvalProfile !== "read-only") {
      this.write(`task ${snapshot.taskId} is not a plan task; create one with /plan <prompt>\n`);
      return;
    }
    const updated = this.#store.updateApprovalProfile(
      snapshot.taskId,
      snapshot.revision,
      this.#approvalProfile,
    );
    this.#controllers.set(
      snapshot.taskId,
      new TaskController(snapshot.taskId, updated.approvalProfile, this.#store),
    );
    this.#currentTaskId = snapshot.taskId;
    this.write(
      `plan approved: ${snapshot.taskId} ${
        updated.approvalProfile === "auto"
          ? "implements the plan in the workspace"
          : "continues in the read-only profile"
      }\n`,
    );
    const refreshed = new TaskController(snapshot.taskId, updated.approvalProfile, this.#store);
    refreshed.queueForContinuation(updated.revision);
    this.#scheduler.enqueue(snapshot.taskId);
    this.drain(new Map([[snapshot.taskId, BUILD_TURN_INSTRUCTION]]));
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
      this.writeUser(transcriptText(redactSensitive(prompt, this.activeSecretsSnapshot())));
      this.write(
        "prompt rejected: credential-shaped content is forbidden; remove any token/api key/password before submitting\n",
      );
      return;
    }
    const currentTaskId = this.#currentTaskId;
    if (currentTaskId === undefined) {
      this.create(prompt);
      return;
    }
    const task = this.ensureController(currentTaskId);
    if (!task) {
      this.write(`current task ${currentTaskId} is unavailable; use /new\n`);
      return;
    }
    const snapshot = task.snapshot();
    if (snapshot.state === "waiting_approval") {
      const pendingActions = this.pendingApprovalActions(currentTaskId);
      this.write(
        pendingActions.length === 0
          ? `task ${currentTaskId} is waiting for an approval decision; use /status ${currentTaskId} for details\n`
          : `task ${currentTaskId} is waiting for your approval; ${pendingActions.join("; ")}\n`,
      );
      return;
    }
    if (snapshot.state === "running") {
      if (snapshot.ownerId !== undefined && snapshot.ownerId !== this.#ownerId) {
        this.write(`task ${currentTaskId} is read-only: owned by ${snapshot.ownerId}\n`);
        return;
      }
      // Codex-style default queueing: ordinary input while the turn runs is
      // queued as a follow-up for the next turn instead of being rejected.
      // /steer <text> remains the explicit way to inject into the active turn.
      void this.queueActiveTurnMessage("followUp", prompt);
      return;
    }
    if (snapshot.state === "queued") {
      this.write(`task ${currentTaskId} is queued; cannot add a prompt to its active turn\n`);
      return;
    }
    if (snapshot.state === "cancelled") {
      this.write(`task ${currentTaskId} is cancelled; use /new to create another task\n`);
      return;
    }
    task.queueForContinuation(snapshot.revision);
    this.#scheduler.enqueue(currentTaskId);
    this.write(`continuing ${currentTaskId}\n`);
    this.drain(new Map([[currentTaskId, prompt]]));
  }

  private newTask(value: string): void {
    const parsed = parseNewTaskInput(value);
    if (parsed === undefined) {
      this.write(
        "usage: /new [prompt] or /new --validator <absolute-executable> [args] -- <goal>\n",
      );
      return;
    }
    // An explicit /new supersedes a bare /plan or /debug that armed the next prompt.
    this.#planPending = false;
    this.#debugPending = false;
    this.#currentTaskId = undefined;
    if (parsed.prompt.length === 0) {
      this.write("new task ready; enter a prompt\n");
      return;
    }
    this.create(parsed.prompt, parsed.validator);
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
    const names = [
      "deepseek",
      "minimax-cn",
      ...this.#configuredModels.map((entry) => entry.credentialName),
    ];
    const uniqueNames = [...new Set(names)];
    const lines = uniqueNames.map((name) => {
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
    const name = parseCredentialName(
      requestedName,
      this.#configuredModels.map((entry) => entry.credentialName),
    );
    if ((action !== "set" && action !== "replace" && action !== "delete") || name === undefined) {
      this.write(
        `credential usage: /credential set|replace|delete <deepseek|minimax-cn${this.#configuredModels
          .map((entry) => `|${entry.credentialName}`)
          .join("")}>\n`,
      );
      return;
    }
    try {
      if (action === "delete") {
        this.#credentialStore.delete(name);
        this.write(`${name} credential deleted\n`);
        return;
      }
      const environmentName = resolveCredentialEnvKey(name);
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
      this.write("Available models (choose with /model <name>):\n");
      for (const choice of CANDY_MODEL_CHOICES) {
        this.write(`  ${choice.value}  ${choice.description ?? ""}\n`);
      }
      for (const entry of this.#configuredModels) {
        this.write(`  ${entry.id}  ${entry.label} (user-configured)\n`);
      }
      return;
    }
    const model = parseModelId(value);
    const configuredId =
      model === undefined && this.#configuredModels.some((entry) => entry.id === value)
        ? value
        : undefined;
    if (model === undefined && configuredId === undefined) {
      this.write(
        "model rejected: choose deepseek-flash, deepseek-pro, deepseek-flash-vision, minimax-m3, or a configured model id\n",
      );
      return;
    }
    this.selectModel(model ?? configuredId!);
  }

  private selectModel(model: CandyModelId): void {
    const current = this.currentTask();
    if (
      this.#selectedAttachmentIds.length > 0 &&
      !isVisionCapableModel(model) &&
      current === undefined
    ) {
      // Staged image attachments would conflict with the next task's payload
      // because non-vision models do not accept images. Clear them as part of
      // the explicit model switch; their binaries stay in the AttachmentStore
      // for cleanupBefore.
      const detachedCount = this.#selectedAttachmentIds.length;
      this.#selectedAttachmentIds = [];
      this.#selectedModel = model;
      this.write(`model selected: ${model}\n`);
      this.write(
        `image attachments detached: ${detachedCount}; use MiniMax M3 or DeepSeek Vision\n`,
      );
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
    // Stored image attachments would collide with a non-vision model on the next
    // `/resume` because the runtime re-feeds them every turn. Persist both
    // changes together so a stale fence cannot leave the task half-switched.
    const detachedCount =
      metadata.attachmentIds.length > 0 && !isVisionCapableModel(model)
        ? metadata.attachmentIds.length
        : 0;
    try {
      const updated =
        detachedCount > 0
          ? this.#store.updateModelAndDetachAttachments(snapshot.taskId, metadata.revision, model)
          : this.#store.updateModel(snapshot.taskId, metadata.revision, model);
      this.#controllers.set(
        snapshot.taskId,
        new TaskController(snapshot.taskId, updated.approvalProfile, this.#store),
      );
      this.#selectedModel = model;
      this.write(`model selected: ${model} for ${snapshot.taskId}\n`);
      if (detachedCount > 0)
        this.write(
          `image attachments detached: ${detachedCount}; use MiniMax M3 or DeepSeek Vision\n`,
        );
    } catch (error) {
      this.write(`model switch rejected: ${safeError(error)}\n`);
    }
  }

  private async attachPath(value: string): Promise<void> {
    if (value === "") throw new Error("Attachment path is required.");
    if (!path.isAbsolute(value)) throw new Error("Attachment paths must be absolute.");
    this.attachmentTarget();
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
    await this.stageImageAttachment(mimeType, content, "attachment staged");
  }

  private attachmentTarget(): {
    readonly snapshot: ReturnType<TaskController["snapshot"]> | undefined;
    readonly taskMetadata: TaskMetadata | undefined;
  } {
    const current = this.currentTask();
    const snapshot = current?.snapshot();
    const taskMetadata = snapshot === undefined ? undefined : this.#store.get(snapshot.taskId);
    if (snapshot !== undefined) {
      if (snapshot.state === "running" || snapshot.state === "waiting_approval")
        throw new Error("Attachments cannot change during an active turn.");
      if (snapshot.state === "queued")
        throw new Error("Attachments cannot change on a queued task.");
      if (!isVisionCapableModel(snapshot.model))
        throw new Error(
          "Image attachments require explicit /model minimax-m3 or /model deepseek-flash-vision.",
        );
      if (taskMetadata === undefined) throw new Error("Task metadata is unavailable.");
    }
    return { snapshot, taskMetadata };
  }

  private async stageImageAttachment(
    mimeType: ClipboardImage["mimeType"],
    content: Uint8Array,
    successPrefix: string,
  ): Promise<void> {
    const { snapshot, taskMetadata } = this.attachmentTarget();
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
      this.write(`${successPrefix}: ${attachment.id}\n`);
      if (!isVisionCapableModel(this.#selectedModel))
        this.write(
          "image attachment requires /model minimax-m3 or /model deepseek-flash-vision before starting a task\n",
        );
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
    this.write(`${successPrefix.replace("staged", "added")}: ${attachment.id}\n`);
  }

  private pasteImageFromClipboard(): void {
    void this.#readClipboardImageImpl()
      .then(async (image) => {
        if (image === undefined) {
          this.write("clipboard image: none; copy an image, then press Ctrl+V\n");
          return;
        }
        await this.stageImageAttachment(image.mimeType, image.content, "clipboard image staged");
      })
      .catch((error: unknown) => {
        this.write(`clipboard image rejected: ${safeError(error)}\n`);
      });
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
          ? "validator not configured; use /validator <absolute-executable> [args]\n"
          : `validator configured: ${this.#validatorCommand.executable} ${this.#validatorCommand.args.join(" ")}\n`,
      );
      return;
    }
    if (value === "off") {
      this.#validatorCommand = undefined;
      this.write("validator cleared for new tasks\n");
      return;
    }
    const command = parseValidatorCommand(value);
    if (command === undefined) {
      this.write("validator rejected: use an absolute executable and safe direct arguments\n");
      return;
    }
    this.#validatorCommand = command;
    this.write(`validator configured for new tasks: ${command.executable}\n`);
  }

  private configurePushPolicy(value: string): void {
    if (value === "") {
      this.write(`push policy for new tasks: ${this.#pushPolicy}\n`);
      return;
    }
    if (value === "allow" || value === "deny") {
      this.#pushPolicy = value;
      this.write(
        `push policy set to ${value} for new tasks${
          value === "allow"
            ? " (applies to current-workspace tasks; Candy never pushes without this explicit authorization)"
            : ""
        }\n`,
      );
      return;
    }
    this.write("push rejected: use /push allow or /push deny\n");
  }

  private async showChanges(): Promise<void> {
    const task = this.currentTask();
    if (task === undefined) {
      this.write("no current task; use /use <task-id> or create a task first\n");
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
    // The anchor line is emitted as its own write so it stays visible in the
    // transcript viewport tail even when the manifest body is long.
    this.write(`changed files: ${snapshot.taskId}\n`);
    this.write(
      [
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
      this.write("no current task; use /use <task-id> or create a task first\n");
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
    // The header is emitted as its own write so it stays visible in the
    // transcript viewport tail even when the diff body is long.
    this.write(`diff ${snapshot.taskId}${requestedPath === "" ? "" : ` ${requestedPath}`}\n`);
    this.write(`${rendered}${rendered.endsWith("\n") ? "" : "\n"}`);
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
    const currentTask = this.currentTask();
    const currentMetadata =
      currentTask === undefined ? undefined : this.#store.get(currentTask.snapshot().taskId);
    if (
      currentMetadata !== undefined &&
      currentMetadata.state === "completed" &&
      currentMetadata.worktreePath === undefined
    ) {
      this.write(
        "direct mode: changes are already in the local workspace; review with /changes and /diff, then commit them with git\n",
      );
      return;
    }
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
        "Review the complete current change list with /changes and the full diff with /diff before Apply.",
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
    const currentTask = this.currentTask();
    const currentMetadata =
      currentTask === undefined ? undefined : this.#store.get(currentTask.snapshot().taskId);
    if (
      currentMetadata !== undefined &&
      currentMetadata.state === "completed" &&
      currentMetadata.worktreePath === undefined
    ) {
      this.write(
        "direct mode: Candy does not reset local changes; review with /changes and /diff, then use git restore/clean to discard them\n",
      );
      return;
    }
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
    const worktreeRoot = resolveTaskWorktreeRoot(workspacePath, this.#worktreeRoot);
    return planGitWorktree(
      workspacePath,
      path.join(worktreeRoot, taskId),
      taskId,
      baseCommit,
      worktreeRoot,
    );
  }

  private planFromMetadata(snapshot: TaskMetadata): GitWorktreePlan {
    return planGitWorktree(
      snapshot.workspacePath,
      snapshot.worktreePath!,
      snapshot.taskId,
      snapshot.workspaceBaseline!,
      path.dirname(snapshot.worktreePath!),
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
      this.write("no current task; use /use <task-id> or create a task first\n");
      return;
    }
    const snapshot = task.snapshot();
    if (snapshot.state === "running" || snapshot.state === "waiting_approval") {
      this.write(`task ${snapshot.taskId} is already running; validator is not started\n`);
      return;
    }
    const metadata = this.#store.get(snapshot.taskId);
    if (metadata?.validator === undefined) {
      this.write("validator not configured for this task; configure it before /new\n");
      return;
    }
    if (this.#validator === undefined) {
      this.#validatorStates.set(snapshot.taskId, {
        status: "blocked",
        evidence: "native runner unavailable",
      });
      this.#taskPhases.set(snapshot.taskId, "validator blocked");
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
    this.#taskPhases.set(snapshot.taskId, "validator running");
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
    this.#taskPhases.set(taskId, `validator ${status}`);
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
    // Render the evidence body before the short status line: the transcript
    // viewport only emits its tail, so long evidence would otherwise scroll
    // the `validator <status>:` anchor out of the terminal byte stream.
    this.write(`${boundedEvidence}\n`);
    this.write(
      `validator ${status}: ${validatorStatusSummary(status, boundedEvidence)}\n${validatorRecoveryHint(taskId, status)}`,
    );
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
      this.write("no current task; use /use <task-id> or create a task first\n");
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

  private invokeSkill(value: string): void {
    const separator = value.search(/[\s]/u);
    const name = separator < 0 ? value : value.slice(0, separator);
    const goal = separator < 0 ? "" : value.slice(separator).trim();
    if (name.length === 0) {
      this.write("usage: /skill <name> [goal]\n");
      this.listSkills();
      return;
    }
    if (goal.length > MAX_TUI_TURN_MESSAGE_CHARS || containsControlCharacter(goal)) {
      this.write("skill goal rejected: text is outside the allowed bounds\n");
      return;
    }
    const content = loadCandySkillContent(
      this.#appDataRoot,
      name,
      this.activeSecretsSnapshot(),
      this.#skillRoots,
    );
    if (content === undefined || content.trim().length === 0) {
      this.write(`skill not found or unreadable: ${name}\n`);
      return;
    }
    const prompt =
      `按照下面的技能执行任务（skill: ${name}）。\n\n` +
      `---\n${content}\n---\n\n` +
      (goal.length === 0 ? "请按技能指示执行。\n" : `任务目标：${goal}\n`);
    this.submitPrompt(prompt);
  }

  private listSkills(): void {
    const result = loadCandySkillInfos(
      this.#appDataRoot,
      this.activeSecretsSnapshot(),
      this.#skillRoots,
    );
    for (const diagnostic of result.diagnostics) {
      this.write(`skill resource ${diagnostic.type}: ${diagnostic.message}\n`);
    }
    if (result.skills.length === 0) {
      this.write("no Candy skills found\n");
      return;
    }
    this.write(
      "Candy skills (model-visible; SKILL.md and references readable via candy_read; scripts runnable via local commands):\n",
    );
    for (const skill of result.skills) {
      this.write(
        `${skill.name}\t${skill.description}\t${skillSourceLabel(skill.baseDir, this.#appDataRoot)}\t${skill.baseDir}\n`,
      );
    }
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
      this.write("usage: /prompt <name> [arguments]\n");
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
    this.#taskPhases.set(taskId, "starting");
    try {
      this.#workspaceReviews.delete(taskId);
      this.#store.clearReview(taskId);
      const taskSnapshot = this.#store.get(taskId);
      if (taskSnapshot === undefined) throw new Error("Task metadata is unavailable after start.");
      if (
        taskSnapshot.trustedShell &&
        !taskSnapshot.fullAccess &&
        (!this.#trustedShellAutoAvailable || !isTrustedShellAutoAvailableOnHost())
      )
        throw new Error(
          process.platform === "win32"
            ? getWindowsTrustedShellCapabilityStatus().reason
            : "Local commands are unavailable because this build has not passed the macOS containment gate.",
        );
      if (taskSnapshot.fullAccess && !this.fullAccessAvailable())
        throw new Error(
          "Full access is unavailable because this build has not passed the macOS preview gate.",
        );
      const executionPath = await this.resolveExecutionPath(taskSnapshot);
      const trustedGitCommonDirectory =
        taskSnapshot.trustedShell && this.#engine instanceof TuiModelRouter
          ? await resolveGitCommonDirectory(taskSnapshot.workspacePath)
          : undefined;
      const trustedDependencyDirectory =
        taskSnapshot.trustedShell && this.#engine instanceof TuiModelRouter
          ? taskSnapshot.worktreePath === undefined
            ? await resolveWorkspaceDependencyDirectory(taskSnapshot.workspacePath)
            : await resolveTaskWorktreeDependencyDirectory(
                taskSnapshot.workspacePath,
                taskSnapshot.worktreePath,
              )
          : undefined;
      const prompt = explicitPrompt;
      if (prompt === undefined)
        throw new Error("Explicit continuation required; the interrupted prompt was not replayed.");
      if (explicitPrompt !== undefined) {
        this.writeUser(transcriptText(explicitPrompt));
        this.#store.appendTranscript(taskId, [
          { role: "user", text: transcriptText(explicitPrompt) },
        ]);
        this.write(`状态：${taskId} 正在处理中（准备上下文并请求模型）\n`);
      }
      const attachments =
        taskSnapshot.attachmentIds.length === 0
          ? undefined
          : await Promise.all(
              taskSnapshot.attachmentIds.map((id) => this.#attachments.getImagePayload(id)),
            );
      if (attachments !== undefined && !isVisionCapableModel(taskSnapshot.model)) {
        throw new Error(
          "The selected model does not accept image attachments; switch to MiniMax M3 or DeepSeek Flash Vision.",
        );
      }
      const runEngineTurn = async (
        activeSecrets: readonly string[],
        turnPrompt: string,
      ): Promise<void> => {
        this.#taskPhases.set(taskId, "turn running");
        // Capture the pre-turn state of isolated tasks so /undo can revert
        // this turn's changes. A fresh worktree at turn 1 captures nothing;
        // /discard resets the whole task to baseline in that case.
        if (taskSnapshot.approvalProfile === "auto" && taskSnapshot.worktreePath !== undefined) {
          await this.captureUndoCheckpoint(taskId, taskSnapshot, activeSecrets);
        }
        const toolActivities = new Map<string, string>();
        const toolActivityKey = createToolActivityKeyResolver(taskId);
        const expandedPrompt = await expandWorkspaceMentionPrompt(
          turnPrompt,
          taskSnapshot.workspacePath,
          activeSecrets,
        );
        if (expandedPrompt.skippedPaths.length > 0) {
          this.write(
            `workspace mentions skipped: ${expandedPrompt.skippedPaths
              .map((value) => redactSensitive(value, activeSecrets))
              .join(", ")}\n`,
          );
        }
        for await (const observation of this.#engine.runTurn(
          {
            taskId,
            prompt: expandedPrompt.prompt,
            model: taskSnapshot.model,
            cwd: executionPath,
            approvalProfile: taskSnapshot.approvalProfile,
            gitPushPolicy:
              taskSnapshot.pushPolicy === "allow" && taskSnapshot.worktreePath === undefined
                ? "allow"
                : "deny",
            activeSecrets,
            ...(taskSnapshot.trustedShell
              ? {
                  trustedShell: true,
                  ...(taskSnapshot.fullAccess ? { fullAccess: true } : {}),
                  ...(trustedGitCommonDirectory === undefined ? {} : { trustedGitCommonDirectory }),
                  ...(trustedDependencyDirectory === undefined
                    ? {}
                    : { trustedDependencyDirectory }),
                  ...(this.#shellRunner?.bashPath === undefined
                    ? {}
                    : { bashPath: this.#shellRunner.bashPath }),
                  shellActiveSecrets: activeSecrets,
                  ...(taskSnapshot.fullAccess || taskSnapshot.worktreePath === undefined
                    ? {}
                    : {
                        shellNetworkApproval: (
                          request: CandyNetworkApprovalRequest,
                          signal: AbortSignal,
                        ) => this.requestNetworkApproval(taskId, request, signal),
                      }),
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
          if (observation.type === "assistant.thinking.delta") {
            const safeText = redactSensitive(observation.text, activeSecrets);
            this.writeThinking(safeText);
          }
          if (observation.type === "assistant.delta") {
            const safeText = redactSensitive(observation.text, activeSecrets);
            this.writeAssistant(safeText);
            this.#store.appendTranscript(taskId, [
              { role: "assistant", text: transcriptText(safeText) },
            ]);
          }
          if (observation.type === "tool.started") {
            const tool = boundedToolName(observation.tool, activeSecrets);
            this.#taskPhases.set(taskId, `tool ${formatToolLabel(tool)}`);
            const activity = formatToolActivity(tool, observation.args, activeSecrets);
            const key = toolActivityKey(tool, observation.toolCallId, "started");
            toolActivities.set(key, activity);
            this.writeToolActivity(key, `◇ ${activity}`);
            this.#store.appendTranscript(taskId, [
              { role: "tool", text: transcriptText(`${activity}: started`) },
            ]);
          }
          if (observation.type === "tool.updated") {
            const tool = boundedToolName(observation.tool, activeSecrets);
            const key = toolActivityKey(tool, observation.toolCallId, "updated");
            this.writeToolActivity(key, `… ${toolActivities.get(key) ?? formatToolIdentity(tool)}`);
          }
          if (observation.type === "tool.completed") {
            const tool = boundedToolName(observation.tool, activeSecrets);
            this.#taskPhases.set(taskId, "turn running");
            const key = toolActivityKey(tool, observation.toolCallId, "completed");
            const activity = toolActivities.get(key) ?? formatToolIdentity(tool);
            const failure = observation.ok ? undefined : toolFailureSummary(observation.failure);
            const summary = `${formatToolIdentity(tool)} ${
              observation.ok ? "完成" : `失败 · ${failure}`
            }`;
            this.writeToolActivity(
              key,
              `${observation.ok ? "✓" : "✗"} ${activity} · ${
                observation.ok ? "完成" : `失败 · ${failure}`
              }`,
            );
            toolActivities.delete(key);
            this.#store.appendTranscript(taskId, [
              {
                role: "tool",
                text: transcriptText(summary),
              },
            ]);
          }
          if (observation.type === "turn.retrying") {
            this.#taskPhases.set(
              taskId,
              `provider retry ${observation.attempt}/${observation.maxAttempts}`,
            );
            this.write(
              `\n[provider retry ${observation.attempt}/${observation.maxAttempts}; waiting ${observation.delayMs}ms]\n`,
            );
          }
          if (observation.type === "turn.retry.completed") {
            this.#taskPhases.set(taskId, "turn running");
            this.write(
              observation.ok
                ? `\n[provider retry ${observation.attempt} succeeded]\n`
                : `\n[provider retry ${observation.attempt} failed]\n`,
            );
          }
          if (observation.type === "turn.compaction") {
            this.#taskPhases.set(
              taskId,
              observation.phase === "started" ? "context compaction" : "turn running",
            );
            this.write(
              observation.phase === "started"
                ? `\n[context compaction: ${observation.reason}]\n`
                : `\n[context compaction ${observation.aborted ? "cancelled" : "settled"}: ${observation.reason}]\n`,
            );
          }
          if (observation.type === "turn.settled") {
            this.#taskPhases.set(taskId, "turn settled");
            this.write("\n[turn settled]\n");
          }
        }
      };
      if (taskSnapshot.taskMode === "debug") {
        await this.runAutoDebug({
          taskId,
          taskSnapshot,
          executionPath,
          goal: prompt,
          runEngineTurn,
          abort,
        });
      } else {
        await this.withActiveSecrets((activeSecrets) => runEngineTurn(activeSecrets, prompt));
      }
      if (this.#closing || abort.signal.aborted)
        throw new Error(this.#closing ? "TUI exit interrupted the task." : "Task owner lost.");
      const current = task.snapshot();
      if (current.state === "running") {
        const completed = task.transition("completed", current.revision);
        this.#taskPhases.set(taskId, "completed");
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
          this.#taskPhases.set(taskId, nextState);
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
            `recovery: /resume ${taskId} <continuation>, /model deepseek-pro, or /cancel ${taskId}\n`,
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

  /**
   * Bounded Auto Debug loop: model turn + validator until pass, stall, or
   * budget. Each failing round appends the redacted validator evidence to the
   * next prompt; progress is persisted through the run store. A non-pass stop
   * throws so the task lands interrupted (explicit continuation only).
   */
  private async runAutoDebug(options: {
    readonly taskId: string;
    readonly taskSnapshot: TaskMetadata;
    readonly executionPath: string;
    readonly goal: string;
    readonly runEngineTurn: (activeSecrets: readonly string[], turnPrompt: string) => Promise<void>;
    readonly abort: AbortController;
  }): Promise<void> {
    const { taskId, taskSnapshot, executionPath, goal, runEngineTurn, abort } = options;
    if (this.#validator === undefined)
      throw new Error("Auto Debug is blocked: the native Sandbox Runner is unavailable.");
    if (taskSnapshot.validator === undefined)
      throw new Error("Auto Debug requires a configured validator.");
    let lastEvidence = "";
    const runner = new LongRunningTaskRunner(MAX_DEBUG_ROUNDS, 2);
    const result = await runner.run(
      async (round, signal) => {
        if (signal.aborted) throw new Error("Auto Debug turn cancelled.");
        const roundPrompt =
          round === 1
            ? goal
            : `${goal}\n\n[VERIFIER FAILED] bounded evidence:\n${lastEvidence}\n\nFix the root cause and re-verify; do not change unrelated files.`;
        // runTask already wrote the initial goal as a user message; only
        // evidence-fed repair rounds append their own prompt to the transcript.
        if (round > 1) {
          this.writeUser(transcriptText(roundPrompt));
          this.#store.appendTranscript(taskId, [
            { role: "user", text: transcriptText(roundPrompt) },
          ]);
        }
        this.#taskPhases.set(taskId, `debug round ${round}/${MAX_DEBUG_ROUNDS}`);
        await this.withActiveSecrets((activeSecrets) => runEngineTurn(activeSecrets, roundPrompt));
      },
      {
        run: async (signal) => {
          const outcome = await this.withActiveSecrets(async (activeSecrets) => ({
            activeSecrets,
            result: await this.#validator!.run(
              taskSnapshot.validator!,
              executionPath,
              signal,
              activeSecrets,
            ),
          }));
          lastEvidence = redactSensitive(outcome.result.evidence, outcome.activeSecrets);
          this.finishValidator(
            taskId,
            outcome.result.ok ? "pass" : "fail",
            lastEvidence,
            outcome.result.durationMs,
          );
          return outcome.result;
        },
      },
      abort.signal,
      {
        store: {
          record: (progress) => {
            const summary = progress.evidenceSummary ?? "";
            this.#store.recordRun({
              taskId,
              rounds: progress.rounds,
              evidenceCount: progress.evidenceCount,
              completed: progress.completed,
              stopReason: progress.stopReason as PersistedRunStopReason,
              ...(progress.lastFingerprintHash === undefined
                ? {}
                : { lastFingerprintHash: progress.lastFingerprintHash }),
              ...(summary.length === 0 ? {} : { evidenceSummary: summary.slice(0, 4_096) }),
            });
          },
        },
      },
    );
    if (!result.completed) {
      const reason =
        result.stopReason === "budget_exhausted"
          ? `budget exhausted after ${result.rounds} rounds`
          : result.stopReason === "stall_detected"
            ? `validator evidence stalled after ${result.rounds} rounds`
            : result.stopReason;
      throw new Error(
        `Auto Debug stopped: ${reason}. Review the saved evidence, then /resume ${taskId} <continuation> to continue.`,
      );
    }
  }

  /**
   * Snapshot the current changed-file set of an isolated task into the
   * in-memory undo history. Credential-bearing content is never captured;
   * history is bounded to the most recent MAX_UNDO_TURNS checkpoints.
   */
  private async captureUndoCheckpoint(
    taskId: string,
    taskSnapshot: TaskMetadata,
    activeSecrets: readonly string[],
  ): Promise<void> {
    if (taskSnapshot.worktreePath === undefined) return;
    try {
      const changes = await this.#changeTracker.inspect(
        taskSnapshot.worktreePath,
        taskSnapshot.workspaceBaseline,
        [],
      );
      const paths = [...changes.tracked, ...changes.untracked];
      if (paths.length === 0) return;
      const snapshots = await captureWorkspaceFileSnapshots(
        taskSnapshot.worktreePath,
        paths,
        activeSecrets,
      );
      if (snapshots.length === 0) return;
      const history = this.#undoHistory.get(taskId) ?? [];
      this.#undoHistory.set(taskId, [...history, snapshots].slice(-MAX_UNDO_TURNS));
      this.write(`\n[checkpoint ${snapshots.length} file(s) for /undo]\n`);
    } catch {
      // Undo capture is best-effort and must never break the active turn.
    }
  }

  /**
   * Restore the latest undo checkpoint of an isolated task. Direct-mode
   * tasks are never touched: Candy does not reset local user changes.
   */
  private undoTask(value: string): void {
    const requested = value.trim();
    const controller =
      requested.length === 0 ? this.currentTask() : this.ensureController(requested);
    if (controller === undefined) {
      this.write(
        requested.length === 0
          ? "no current task; create or select a task first\n"
          : `task ${requested} does not exist\n`,
      );
      return;
    }
    const snapshot = controller.snapshot();
    if (
      snapshot.state === "running" ||
      snapshot.state === "waiting_approval" ||
      snapshot.state === "queued"
    ) {
      this.write(
        `task ${snapshot.taskId} has an active or queued turn; /undo applies after the turn completes\n`,
      );
      return;
    }
    const metadata = this.#store.get(snapshot.taskId);
    if (metadata === undefined) {
      this.write(`task ${snapshot.taskId} metadata is unavailable\n`);
      return;
    }
    if (metadata.worktreePath === undefined) {
      this.write(
        `task ${snapshot.taskId} is in the current workspace; /undo is available in /access safe. Review with /changes and /diff, then use git restore/clean\n`,
      );
      return;
    }
    const history = this.#undoHistory.get(snapshot.taskId) ?? [];
    const checkpoint = history.at(-1);
    if (checkpoint === undefined || checkpoint.length === 0) {
      this.write(`task ${snapshot.taskId} has no undo checkpoint\n`);
      return;
    }
    void this.withActiveSecrets(async (activeSecrets) => {
      const restored = await restoreWorkspaceFileSnapshots(
        metadata.worktreePath!,
        checkpoint,
        activeSecrets,
      );
      if (restored === 0) {
        this.write("undo: no restorable files in the latest checkpoint\n");
        return;
      }
      this.#undoHistory.set(snapshot.taskId, history.slice(0, -1));
      this.#workspaceReviews.delete(snapshot.taskId);
      this.#store.clearReview(snapshot.taskId);
      this.write(
        `undo: restored ${restored} file(s) in ${snapshot.taskId}; re-review with /changes and /diff\n`,
      );
    }).catch((error: unknown) => {
      this.write(`undo blocked: ${safeError(error)}\n`);
    });
  }

  private showCheckpoints(): void {
    const task = this.currentTask();
    if (task === undefined) {
      this.write("no current task; create or select a task first\n");
      return;
    }
    const taskId = task.snapshot().taskId;
    const history = this.#undoHistory.get(taskId) ?? [];
    if (history.length === 0) {
      this.write(`no undo checkpoints for ${taskId}\n`);
      return;
    }
    for (const [index, checkpoint] of history.entries()) {
      this.write(`${index + 1}\t${checkpoint.length} file(s)\n`);
    }
    this.write(`use /undo to restore the latest checkpoint of ${taskId}\n`);
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
      this.write(
        `\n[${mode === "steer" ? "steer" : "follow-up"}] ${transcriptText(
          redactSensitive(text, this.activeSecretsSnapshot()),
        )}\n`,
      );
      this.write(
        "turn message rejected: credential-shaped content is forbidden; remove any token/api key/password\n",
      );
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
        this.write(`use /resume ${taskId} <continuation> after reviewing the saved evidence\n`);
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

  private showHelp(): void {
    this.write("Candy commands: full reference in docs/usage/tui-commands.md\n");
    for (const command of CANDY_SLASH_COMMANDS) {
      const syntax =
        command.usage ??
        `/${command.name}${command.argumentHint === undefined ? "" : ` ${command.argumentHint}`}`;
      this.write(
        `  ${syntax}${command.description === undefined ? "" : ` — ${command.description}`}\n`,
      );
    }
  }

  private showResumableTasks(): void {
    const resumable = this.#store
      .list()
      .filter((task) => task.state === "paused" || task.state === "interrupted")
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    if (resumable.length === 0) {
      this.write("no paused or interrupted tasks to resume\n");
      return;
    }
    this.write(`resumable tasks (${resumable.length}):\n`);
    for (const [index, task] of resumable.entries()) {
      const details = [
        task.taskId,
        task.state,
        task.model,
        ...(task.updatedAt === undefined ? [] : [formatElapsed(task.updatedAt)]),
        ...(task.workspacePath === this.#workspacePath ? [] : [task.workspacePath]),
      ].join(" · ");
      this.write(`  ${index + 1}. ${task.title ?? task.taskId}\n    ${details}\n`);
    }
    this.write("choose with /resume <task-id> <continuation> after reviewing the saved evidence\n");
  }

  private printTasks(): void {
    for (const task of this.#store.list()) {
      const current = task.taskId === this.#currentTaskId ? "*" : " ";
      const validator = this.validatorStatus(task);
      const workspaceState = task.worktreePath === undefined ? "local" : "worktree";
      this.write(
        `${current}${task.taskId}\ttitle=${task.title ?? task.taskId}\t${task.state}\tcreated=${formatTaskTimestamp(task.createdAt)}\tupdated=${formatTaskTimestamp(task.updatedAt)}\t${task.model}\t${task.workspacePath}\tr${task.revision}\tq${task.queueOrder ?? "-"}\tworkspace=${workspaceState}\tmode=${task.taskMode ?? "build"}\taccess=${task.fullAccess ? "full" : task.approvalProfile === "read-only" ? "review" : "auto"}\tlocal-commands=${task.trustedShell ? "on" : "off"}\tplan=${task.approvalProfile === "read-only" ? "on" : "off"}\tvalidator=${validator}\n`,
      );
    }
  }

  private showStatus(requestedTaskId: string): void {
    const taskId = requestedTaskId || this.#currentTaskId;
    if (taskId === undefined) {
      this.write("no current task; use /new or /use <task-id> first\n");
      return;
    }
    const task = this.#store.get(taskId);
    if (task === undefined) {
      this.write(`task ${taskId} does not exist\n`);
      return;
    }
    const workspaceState = task.worktreePath === undefined ? "local" : "worktree";
    const pendingApprovals = [
      ...[...this.#networkApprovals.entries()]
        .filter(([, approval]) => approval.taskId === task.taskId)
        .map(([id, approval]) => `network ${id} (${approval.summary})`),
    ];
    const run = this.#store.getRun(task.taskId);
    const validator = this.validatorStatus(task);
    const lines = [
      `status ${task.taskId}`,
      `title: ${task.title ?? task.taskId}`,
      `state: ${task.state}`,
      `phase: ${this.#taskPhases.get(task.taskId) ?? task.state}`,
      `profile: ${task.approvalProfile}${
        task.approvalProfile === "read-only" ? " (plan mode; /build to implement)" : ""
      }`,
      `mode: ${task.taskMode ?? "build"}`,
      `access: ${task.fullAccess ? "full (macOS preview)" : task.approvalProfile === "read-only" ? "review" : "auto"}`,
      `workspace: ${workspaceState} ${task.worktreePath ?? task.workspacePath}`,
      `local commands: ${task.trustedShell ? (task.fullAccess ? "full access ready" : "offline ready") : "off"}`,
      `git: push=${task.pushPolicy}${task.worktreePath !== undefined ? " (worktree task; push unavailable)" : ""}`,
      `model: ${task.model}`,
      `revision: r${task.revision}`,
      `created: ${formatTaskTimestamp(task.createdAt)}`,
      `updated: ${formatTaskTimestamp(task.updatedAt)}`,
      `owner: ${task.ownerId ?? "none"}`,
      `approval: ${pendingApprovals.length === 0 ? "none" : pendingApprovals.join(", ")}`,
      `validator: ${validator}`,
      `run: ${
        run === undefined
          ? "none"
          : `${run.stopReason}, rounds=${run.rounds}, evidence=${run.evidenceCount}${
              run.evidenceSummary === undefined
                ? ""
                : `, summary=${redactSensitive(run.evidenceSummary, this.activeSecretsSnapshot())}`
            }`
      }`,
    ];
    const recovery =
      task.state === "waiting_approval"
        ? this.pendingApprovalActions(task.taskId).length === 0
          ? "action required: an approval is pending; wait for the active TUI owner or use /cancel"
          : `action required: ${this.pendingApprovalActions(task.taskId).join("; ")}`
        : task.state === "paused" || task.state === "interrupted"
          ? `recovery: /resume ${task.taskId} <continuation> (explicit; no replay) or /cancel ${task.taskId}`
          : validator === "fail" || validator === "timeout" || validator === "cancelled"
            ? `recovery: fix the workspace, then /validate; or /resume ${task.taskId} <continuation>`
            : undefined;
    if (recovery !== undefined) lines.push(recovery);
    this.write(`${lines.join("\n")}\n`);
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
    if (value === "read-only") {
      this.#trustedShellEnabled = false;
    }
    this.write(
      value === "auto"
        ? `profile auto: file read/create/edit/delete enabled; offline local commands ${this.localCommandsEnabled() ? "on" : "off"}\n`
        : "profile read-only: file mutation disabled\n",
    );
  }

  private localCommandsEnabled(): boolean {
    return (
      this.#approvalProfile === "auto" &&
      this.#shellRunner !== undefined &&
      this.#trustedShellAutoAvailable &&
      isTrustedShellAutoAvailableOnHost() &&
      (this.#trustedShellEnabled || !this.#trustedShellDisabled)
    );
  }

  private fullAccessAvailable(): boolean {
    return (
      this.#fullAccessAvailable && isMacosFullAccessAvailable() && this.#shellRunner !== undefined
    );
  }

  private fullAccessEnabled(): boolean {
    return this.#fullAccessEnabled && this.fullAccessAvailable();
  }

  private setFullAccessDefault(enabled: boolean): void {
    this.#fullAccessEnabled = enabled;
    this.#fullAccessConfirmationPending = false;
    this.#store.setFullAccessDefaultEnabled(enabled);
  }

  private setWorktree(value: string): void {
    if (value !== "on" && value !== "off") {
      this.write("worktree must be on or off\n");
      return;
    }
    this.#worktreeEnabled = value === "on";
    this.write(
      value === "on"
        ? "访问模式：安全工作区（默认）；新任务在隔离副本中完成，变更可审阅后应用\n"
        : "访问模式：当前工作区；新任务直接编辑当前工作区，请在提交前审阅变更\n",
    );
  }

  private setLocalCommands(value: string): void {
    if (value === "") {
      this.write(`Offline local commands: ${this.localCommandsEnabled() ? "on" : "off"}\n`);
      return;
    }
    if (value !== "on" && value !== "off" && value !== "auto") {
      this.write("local must be on, off, or auto\n");
      return;
    }
    if (value === "off") {
      this.#trustedShellEnabled = false;
      this.#trustedShellDisabled = true;
      this.write("Local commands disabled for new tasks\n");
      return;
    }
    if (process.platform !== "darwin" && process.platform !== "win32") {
      this.write("Local commands unavailable: this platform is not supported\n");
      return;
    }
    if (this.#approvalProfile !== "auto") {
      this.write("Local commands require /profile auto\n");
      return;
    }
    if (this.#shellRunner === undefined) {
      this.write(
        "Local commands unavailable: Native Sandbox Runner is unavailable on this installation\n",
      );
      return;
    }
    if (!this.#trustedShellAutoAvailable || !isTrustedShellAutoAvailableOnHost()) {
      if (process.platform === "win32") {
        this.write(
          `Local commands unavailable: ${getWindowsTrustedShellCapabilityStatus().reason}\n`,
        );
      } else {
        this.write("Local commands unavailable: the macOS gate has not enabled this build\n");
      }
      return;
    }
    // Compatibility for the formerly public `/local on` command: it retains
    // the old safe-workspace behavior, including bounded network approvals.
    // `/access current` deliberately does not take this path.
    if (!this.#worktreeEnabled) this.#worktreeEnabled = true;
    this.#trustedShellDisabled = false;
    this.#trustedShellEnabled = true;
    this.write(
      "Local commands enabled for the next Auto Git Task; offline commands run automatically\n",
    );
  }

  private setAccess(value: string): void {
    if (value === "") {
      const mode = this.fullAccessEnabled()
        ? "⚠ Full access（macOS 默认）"
        : this.#approvalProfile === "read-only"
          ? "只读审阅"
          : this.#worktreeEnabled
            ? "安全工作区（默认）"
            : "当前工作区";
      this.write(
        `访问模式：${mode}\n` +
          "  /access review   只读分析，不修改文件或运行本地检查\n" +
          "  /access safe     默认；在安全副本中工作，本地检查自动离线运行\n" +
          "  /access current  直接在当前工作区工作，本地检查自动离线运行\n" +
          "  /access full     macOS 预览；首次确认后成为默认模式，直到 /access safe\n" +
          "  /access current 与 Full access 可叠加（宽沙箱 + 直接工作区，Codex 风格）\n" +
          "  安全工作区的网络逐条确认；当前工作区默认不开放网络命令，Full access 生效时除外；Full access 不授予凭据、提交、推送、发布或部署\n",
      );
      return;
    }
    if (value === "review") {
      this.#approvalProfile = "read-only";
      this.#trustedShellEnabled = false;
      this.write("访问模式：只读审阅；Candy 只分析，不修改文件或运行本地检查\n");
      return;
    }
    if (value === "full") {
      if (!this.fullAccessAvailable()) {
        this.write("Full access unavailable: requires the macOS arm64 Personal Preview runner\n");
        return;
      }
      if (this.fullAccessEnabled()) {
        this.write(
          "Full access is already the macOS default; use /access safe to return to the default sandbox\n",
        );
        return;
      }
      this.#fullAccessConfirmationPending = true;
      this.write(
        "Full access warning: future Auto Git tasks may read/write local files and use the network outside Candy's normal sandbox until you run /access safe. Provider credentials are removed from child environments and Keychain credential IPC remains denied; Candy still blocks automatic commit, push, publishing, release, and deployment. Confirm with /access full confirm\n",
      );
      return;
    }
    if (value === "full confirm") {
      if (!this.fullAccessAvailable()) {
        this.write("Full access unavailable: requires the macOS arm64 Personal Preview runner\n");
        return;
      }
      if (!this.#fullAccessConfirmationPending) {
        this.write("Full access confirmation requires reviewing /access full warning first\n");
        return;
      }
      this.#approvalProfile = "auto";
      this.setFullAccessDefault(true);
      this.#trustedShellDisabled = false;
      this.#trustedShellEnabled = false;
      this.write(
        "Full access is now the macOS default for future Auto tasks; ⚠ FULL ACCESS remains visible in the status bar. Use /access safe to return to the default sandbox\n",
      );
      return;
    }
    if (value !== "safe" && value !== "current") {
      this.write("access must be review, safe, current, or full\n");
      return;
    }
    this.#approvalProfile = "auto";
    this.#worktreeEnabled = value === "safe";
    this.#trustedShellDisabled = false;
    this.#trustedShellEnabled = false;
    // /access safe is the documented Full-access exit; /access current keeps
    // the Full-access sandbox so wide-sandbox direct-workspace tasks work
    // Codex-style.
    if (value === "safe") this.setFullAccessDefault(false);
    const fullAccessNote = this.fullAccessEnabled() ? "；Full access 宽沙箱生效（文件+网络）" : "";
    this.write(
      value === "safe"
        ? "访问模式：安全工作区（默认）；新任务在隔离副本中工作，本地检查自动离线运行；网络仍逐条确认\n"
        : `访问模式：当前工作区；新任务直接编辑当前工作区，本地检查自动离线运行；网络命令不开放${fullAccessNote}\n`,
    );
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
      this.#networkApprovals.set(approvalId, {
        taskId,
        summary: redactSensitive(request.reason, this.activeSecretsSnapshot()),
        settle,
      });
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
      this.#taskPhases.set(taskId, "waiting for your approval");
      this.writeApprovalRequest({
        taskId,
        approvalId,
        action: "执行受限网络命令",
        details: [
          `命令：${formatApprovalField(request.command)}`,
          `原因：${formatApprovalField(request.reason)}`,
          `目录：${formatApprovalField(canonicalTaskWorktree)}`,
          `超时：${request.timeout === undefined ? "无" : `${request.timeout}s`}`,
        ],
        approveText: "执行此命令并继续任务",
        denyText: "拒绝此命令并继续任务",
      });
    });
  }

  private pendingApprovalActions(taskId: string): readonly string[] {
    return [
      ...[...this.#networkApprovals.entries()]
        .filter(([, approval]) => approval.taskId === taskId)
        .map(([approvalId]) => `/approve ${approvalId} or /deny ${approvalId}`),
    ];
  }

  private writeApprovalRequest({
    taskId,
    approvalId,
    action,
    details,
    approveText,
    denyText,
  }: {
    readonly taskId: string;
    readonly approvalId: string;
    readonly action: string;
    readonly details: readonly string[];
    readonly approveText: string;
    readonly denyText: string;
  }): void {
    this.writeApproval(
      [
        "! 需要你的确认",
        `  操作  ${action}`,
        ...details.map((detail) => `  ${detail}`),
        `  任务  ${taskId}`,
        "状态：任务已暂停，等待你的选择；Candy 不会自行继续。",
        "",
        `/approve ${approvalId}  ${approveText}`,
        `/deny ${approvalId}     ${denyText}`,
        `/cancel ${taskId}       取消整个任务`,
        "",
        // Tail anchor: the transcript viewport only emits its tail, so long
        // detail lines (wrapped reasons and paths) can scroll the frame head
        // out of the terminal byte stream. The compact actionable summary is
        // repeated as the final line so it always stays visible.
        approvalActionAnchor(action, details, approvalId),
      ].join("\n"),
    );
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
    const [canonicalPath, root] = await Promise.all([
      realpath(executionPath).catch(() => undefined),
      lstat(executionPath).catch(() => undefined),
    ]);
    if (canonicalPath === undefined || root?.isSymbolicLink() === true)
      throw new Error("The local-command workspace is unavailable or symlinked.");
    return canonicalPath;
  }

  private resolveApproval(approvalId: string, approved: boolean): void {
    const networkApproval = this.#networkApprovals.get(approvalId);
    if (networkApproval !== undefined) {
      networkApproval.settle(approved);
      this.write(`${networkApproval.taskId} network ${approved ? "approved" : "denied"}\n`);
      return;
    }
    this.write(`${approvalId} is not awaiting approval\n`);
  }

  private write(value: string): void {
    this.flushAssistantRun();
    this.#surface?.appendTranscript(redactTuiOutput(value));
  }

  private writeUser(value: string): void {
    this.flushAssistantRun();
    this.#surface?.appendTranscript(redactTuiOutput(value), "user");
  }

  private writeApproval(value: string): void {
    this.flushAssistantRun();
    this.#surface?.appendTranscript(redactTuiOutput(value), "approval");
  }

  private writeToolActivity(key: string, value: string): void {
    this.flushAssistantRun();
    this.#surface?.upsertToolActivity(key, redactTuiOutput(value));
  }

  /**
   * Stream model text through the markdown-rendered transcript channel and
   * accumulate it into the current assistant run for Ctrl+X copy.
   */
  private writeAssistant(value: string): void {
    const safe = redactTuiOutput(value);
    this.#surface?.appendTranscript(safe, "assistant");
    this.#assistantBuffer += safe;
    this.#inAssistantRun = true;
  }

  /**
   * Stream model reasoning through the dim, collapsed thinking channel. It is
   * never persisted to the task store and never enters the copy buffer.
   */
  private writeThinking(value: string): void {
    this.#surface?.appendTranscript(redactTuiOutput(value), "thinking");
  }

  /** End the current assistant run; the accumulated text becomes the last reply. */
  private flushAssistantRun(): void {
    if (!this.#inAssistantRun) return;
    this.#lastAssistantReply = this.#assistantBuffer;
    this.#assistantBuffer = "";
    this.#inAssistantRun = false;
  }

  /** Copy the last assistant reply to the system clipboard (Ctrl+X). */
  private copyLastAssistant(): void {
    this.flushAssistantRun();
    const text = this.#lastAssistantReply;
    if (text.trim().length === 0) {
      this.write("clipboard: no assistant reply to copy\n");
      return;
    }
    this.#copyToClipboardImpl(text)
      .then(() => {
        this.write(`clipboard: copied ${text.length} chars\n`);
      })
      .catch((error: unknown) => {
        this.write(`clipboard: ${safeError(error)}\n`);
      });
  }

  /** Cycle the selected model through the Candy model choices (Ctrl+P). */
  private cycleModel(direction: 1 | -1): void {
    const current = this.currentTask()?.snapshot().model ?? this.#selectedModel;
    const order = [
      ...CANDY_MODEL_CHOICES.map((choice) => choice.value),
      ...this.#configuredModels.map((entry) => entry.id),
    ];
    const index = order.findIndex((value) => parseModelId(value) === current);
    const base = index === -1 ? 0 : index;
    const next = order[(base + direction + order.length) % order.length];
    if (next !== undefined) this.configureModel(next);
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
    private readonly customEngines: ReadonlyMap<string, TuiAgentEngine> = new Map(),
  ) {}

  public async *runTurn(
    input: PiAgentEngineInput,
    signal: AbortSignal,
  ): AsyncIterable<PiAgentObservation> {
    const engine =
      input.model === "MiniMax-M3"
        ? this.minimax
        : (this.customEngines.get(input.model) ?? this.deepseek);
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

/** Classify a loaded skill's source by its base directory. */
function skillSourceLabel(baseDir: string, appDataRoot: string): string {
  let root = appDataRoot;
  try {
    root = realpathSync(appDataRoot);
  } catch {
    // Keep the resolved path when realpath is unavailable.
  }
  if (isPathInside(root, baseDir)) return "candy";
  if (baseDir.includes(path.join(".agents", "skills"))) return "shared";
  return "configured";
}

function parseModelId(value: string): CandyModelId | undefined {
  switch (value.toLowerCase()) {
    case "deepseek-flash":
    case "deepseek-v4-flash":
      return "deepseek-v4-flash";
    case "deepseek-pro":
    case "deepseek-v4-pro":
      return "deepseek-v4-pro";
    case "deepseek-flash-vision":
    case "deepseek-v4-flash-vision-exp":
      return "deepseek-v4-flash-vision-exp";
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

function parseValidatorCommand(value: string): CommandValidatorCommand | undefined {
  const parts = value.split(/\s+/u).filter((part) => part.length > 0);
  const executable = parts.shift();
  if (
    executable === undefined ||
    !isAbsoluteCommandPath(executable) ||
    containsControlCharacter(value) ||
    containsCredentialMaterial(value)
  )
    return undefined;
  return { executable, args: parts };
}

function parseNewTaskInput(
  value: string,
): { readonly prompt: string; readonly validator?: CommandValidatorCommand } | undefined {
  const trimmed = value.trim();
  if (trimmed !== "--validator" && !trimmed.startsWith("--validator ")) return { prompt: trimmed };
  const validatorAndGoal = trimmed.slice("--validator".length).trim();
  const separator = validatorAndGoal.indexOf(" -- ");
  if (separator < 0) return undefined;
  const validator = parseValidatorCommand(validatorAndGoal.slice(0, separator).trim());
  const prompt = validatorAndGoal.slice(separator + 4).trim();
  if (validator === undefined || prompt.length === 0) return undefined;
  return { prompt, validator };
}

function formatTaskTimestamp(timestamp: number | undefined): string {
  if (timestamp === undefined) return "-";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "-" : date.toISOString();
}

function formatElapsed(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function validatorRecoveryHint(
  taskId: string,
  status: "pass" | "fail" | "cancelled" | "timeout",
): string {
  if (status === "pass") return "";
  return `recovery: fix the workspace, then /validate; or /resume ${taskId} <continuation>\n`;
}

function approvalActionAnchor(
  action: string,
  details: readonly string[],
  approvalId: string,
): string {
  const firstDetail = (details[0] ?? "").trim();
  const bounded = firstDetail.length <= 88 ? firstDetail : `${firstDetail.slice(0, 88)}…`;
  const summary = `操作：${action}${bounded.length === 0 ? "" : ` · ${bounded}`}`;
  return `${summary} · /approve ${approvalId}`;
}

function validatorStatusSummary(
  status: Exclude<TuiValidatorStatus, "configured" | "running" | "blocked">,
  evidence: string,
): string {
  if (evidence.trim().length === 0) return "";
  const firstLine =
    evidence
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  // "validator cancelled"/"validator timeout" evidence would repeat the status.
  const summary = firstLine.startsWith(`validator ${status}`) ? "" : firstLine;
  return summary.length <= 160 ? summary : `${summary.slice(0, 160)}…`;
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

function formatToolActivity(
  tool: string,
  args: string | undefined,
  activeSecrets: readonly string[],
): string {
  const label = formatToolLabel(tool);
  const details = summarizeToolArguments(args, activeSecrets);
  const activity = details === undefined ? label : `${label}：${details}`;
  return label === tool ? activity : `${activity} · ${tool}`;
}

function formatToolLabel(tool: string): string {
  const labels: Readonly<Record<string, string>> = {
    candy_list: "列出目录",
    candy_read: "读取文件",
    candy_read_image: "读取图片",
    candy_search: "搜索代码",
    candy_edit: "编辑文件",
    candy_write: "写入文件",
    candy_delete: "删除文件",
    candy_bash: "运行命令",
    candy_web_fetch: "读取网页",
    candy_bash_network: "读取网络资源",
  };
  return labels[tool] ?? tool.replace(/^candy_/u, "").replaceAll("_", " ");
}

function formatToolIdentity(tool: string): string {
  const label = formatToolLabel(tool);
  return label === tool ? tool : `${label} · ${tool}`;
}

function toolFailureSummary(failure: PiToolFailure | undefined): string {
  switch (failure?.kind) {
    case "read_offset_out_of_range":
      return `起始行超过文件末尾（当前共 ${failure.totalLines} 行）；请重新读取后重试`;
    case "edit_target_not_found":
      return "编辑目标已变化或文本不匹配；请重新读取后重试";
    case "edit_target_not_unique":
      return "编辑目标不唯一；请提供更多上下文后重试";
    case "edit_targets_overlap":
      return "多个编辑范围重叠；请合并为一个编辑后重试";
    case "edit_no_change":
      return "替换没有产生变化；请检查目标与替换内容";
    case "local_dependency_unavailable":
      return "本地依赖不可用；Candy 不会自动下载，请先在源工作区安装依赖后新建任务";
    case "local_command_credential_forbidden":
      return "本地命令不能包含 Provider 凭据";
    case "local_command_publication_forbidden":
      return "本地命令不允许提交、推送、发布或部署";
    case "local_command_failed":
      return "本地命令未通过；原始输出已隐藏，请让任务根据错误继续修复，或检查脚本与本地依赖";
    default:
      return "工具未完成；请重新读取上下文后重试";
  }
}

function createToolActivityKeyResolver(
  taskId: string,
): (
  tool: string,
  toolCallId: string | undefined,
  phase: "started" | "updated" | "completed",
) => string {
  let anonymousSequence = 0;
  const activeAnonymousKeys = new Map<string, string[]>();

  return (tool, toolCallId, phase) => {
    if (toolCallId !== undefined) return `${taskId}:${toolCallId}`;

    const activeKeys = activeAnonymousKeys.get(tool) ?? [];
    if (phase === "started" || activeKeys.length === 0) {
      const key = `${taskId}:${tool}:anonymous-${++anonymousSequence}`;
      if (phase !== "completed") {
        activeKeys.push(key);
        activeAnonymousKeys.set(tool, activeKeys);
      }
      return key;
    }

    const key = activeKeys[0]!;
    if (phase === "completed") {
      activeKeys.shift();
      if (activeKeys.length === 0) activeAnonymousKeys.delete(tool);
    }
    return key;
  };
}

function summarizeToolArguments(
  value: string | undefined,
  activeSecrets: readonly string[],
): string | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const pathValue = summarizeToolField(record.path, activeSecrets);
    const queryValue = summarizeToolField(record.query, activeSecrets);
    const parts = [pathValue, queryValue === undefined ? undefined : `“${queryValue}”`].filter(
      (part): part is string => part !== undefined,
    );
    const offset = typeof record.offset === "number" ? record.offset : undefined;
    const limit = typeof record.limit === "number" ? record.limit : undefined;
    if (
      pathValue !== undefined &&
      offset !== undefined &&
      limit !== undefined &&
      Number.isSafeInteger(offset) &&
      Number.isSafeInteger(limit)
    )
      parts.push(`第 ${offset + 1}–${offset + limit} 行`);
    return parts.length === 0 ? undefined : parts.join(" · ");
  } catch {
    return undefined;
  }
}

function summarizeToolField(value: unknown, activeSecrets: readonly string[]): string | undefined {
  if (typeof value !== "string") return undefined;
  const summary = replaceToolControlCharacters(redactSensitive(value, activeSecrets)).trim();
  return summary.length <= 160 ? summary : `${summary.slice(0, 160)}…`;
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
  if (error instanceof Error && /^Auto Debug stopped:/u.test(error.message)) return error.message;
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

function parseCredentialName(
  value: string | undefined,
  configuredNames: readonly string[] = [],
): CredentialName | undefined {
  if (value === "deepseek") return "deepseek";
  if (value === "minimax" || value === "minimax-cn") return "minimax-cn";
  if (value !== undefined && isValidCredentialName(value) && configuredNames.includes(value))
    return value;
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
