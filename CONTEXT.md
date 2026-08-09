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

**Long-running Task**:
A Candy Task with an explicit outcome and verification criteria that may continue, pause, resume, and be steered while Candy remains running.
_Avoid_: Detached job, workflow

**Auto Debug**:
A Long-running Task that repeatedly gathers failure evidence, changes the project, and reruns an explicit validator until success or a stop condition.
_Avoid_: Workflow engine, autonomous deployment
