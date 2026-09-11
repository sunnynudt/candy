---
status: accepted
---

# Run bounded parallel tasks with one agent per task

Candy V1 permits multiple independent tasks to run concurrently while keeping exactly one agent and one execution owner per task. This replaces the original global single-active-session constraint: it improves throughput without introducing collaborating agents, detached execution, or a general workflow engine. Writable tasks targeting the same repository use separate Git worktrees, and Candy limits concurrency to three tasks by default and five tasks at most.

## Consequences

Side-effect-free tools may run concurrently inside a task, while file mutations and shell commands are sequential by default. Tasks beyond the limit wait in a reorderable FIFO queue. Closing the Desktop window leaves Candy running in the tray or menu bar; explicitly quitting Candy cancels running tasks. Completed worktrees remain until the user applies or discards their changes.
