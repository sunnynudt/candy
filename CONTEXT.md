# Candy Product Context

Candy is a standalone, local-first coding product in which users run independent AI-assisted tasks with domestic models while retaining control of credentials, code changes, and external actions.

## Language

**Candy Task**:
A unit of user-requested work with one agent and one persistent session. Tasks are independently schedulable and may run concurrently.
_Avoid_: Active session, agent job

**Running Task**:
A Candy Task whose agent or tools are currently executing. More than one task may be running, subject to the product's concurrency limit.
_Avoid_: Global active session

**Execution Owner**:
The single client or runtime instance allowed to advance a Candy Task. Ownership is exclusive per task, not global to Candy.
_Avoid_: Global execution lock owner

**Task Queue**:
The ordered set of Candy Tasks waiting for an execution slot.
_Avoid_: Workflow, pipeline

**Local Workspace**:
The project directory selected by the user for direct foreground work.
_Avoid_: Main worktree, target checkout

**Task Worktree**:
The isolated Git checkout associated with a Candy Task for parallel or background work.
_Avoid_: Temporary repository, workspace clone

**Workspace Handoff**:
The user-visible transfer of a Candy Task between its Local Workspace and associated Task Worktree.
_Avoid_: Session migration, auto-merge

**Apply Changes**:
The user-approved transfer of a completed task's reviewed patch into the target workspace as uncommitted changes.
_Avoid_: Auto-merge, auto-commit

**Primary Model**:
The model selected to control reasoning, coding, and tool use for a Candy Task. Candy V1 supports DeepSeek V4 Flash, DeepSeek V4 Pro, and MiniMax M3 as Primary Models.
_Avoid_: Vision Provider, helper model

**Multimodal Task**:
A Candy Task whose Primary Model accepts native non-text attachments. MiniMax M3 provides image understanding in V1.
_Avoid_: Vision handoff, OCR task

**Browser Workspace**:
The task-bound browser surface shared by the user and agent for viewing, operating, and verifying web pages.
_Avoid_: Headless browser, browser tool process

**Browser Profile**:
Candy-owned browsing identity and history kept separate from the user's regular browser profile and provider credentials.
_Avoid_: Chrome profile, task credentials

**Browser Control Owner**:
The single user or agent currently allowed to operate a Browser Workspace tab. Control always returns to the user through detected user interaction or an explicit Take Control action.
_Avoid_: Browser lock, tab owner

**Sandbox Runner**:
The audited native helper that applies operating-system command containment and owns the launched process tree. Candy task, model, approval, provider, and product policy remain outside it.
_Avoid_: Shell wrapper, sandbox service

**Full Access**:
A user-selected, persistent execution profile with the same contract on every supported host: a task may use broad local files, local commands, and outbound network access without per-command approval. It never conveys a Candy provider credential, bypasses credential scanning, or implicitly authorizes push, publishing, release, or deployment.
_Avoid_: macOS Full access, unrestricted shell, trusted shell

**Full Access Backend**:
The platform-specific operating-system isolation mechanism that realizes Full Access while keeping the task separate from Candy credentials and owning its complete process tree.
_Avoid_: Full trust fallback, Job Object sandbox

**Acceptance Gate**:
A named set of observable pass criteria and required evidence that a Candy slice or release must satisfy before it is considered complete.
_Avoid_: QA phase, test checklist

**Long-running Task**:
A Candy Task with an explicit outcome and verification criteria that may continue, pause, resume, and be steered while Candy remains running.
_Avoid_: Detached job, workflow

**Auto Debug**:
A Long-running Task that repeatedly gathers failure evidence, changes the project, and reruns an explicit validator until success or a stop condition.
_Avoid_: Workflow engine, autonomous deployment
