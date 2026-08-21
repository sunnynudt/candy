import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteProvider,
  type SlashCommand,
} from "@earendil-works/pi-tui";

const MODEL_COMPLETIONS: readonly AutocompleteItem[] = [
  {
    value: "deepseek-flash",
    label: "deepseek-flash",
    description: "DeepSeek V4 Flash",
  },
  {
    value: "deepseek-pro",
    label: "deepseek-pro",
    description: "DeepSeek V4 Pro",
  },
  {
    value: "minimax-m3",
    label: "minimax-m3",
    description: "MiniMax M3",
  },
];

function completeModels(argumentPrefix: string): AutocompleteItem[] {
  const prefix = argumentPrefix.trim().toLowerCase();
  return MODEL_COMPLETIONS.filter((item: AutocompleteItem): boolean =>
    item.value.toLowerCase().startsWith(prefix),
  );
}

export const CANDY_SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "model",
    argumentHint: "<model>",
    description: "Choose the primary model",
    getArgumentCompletions: completeModels,
  },
  {
    name: "new",
    argumentHint: "[prompt]",
    description: "Create a new task",
  },
  {
    name: "workspace",
    argumentHint: "[path]",
    description: "Show or select the workspace",
  },
  {
    name: "profile",
    argumentHint: "read-only|auto",
    description: "Choose the approval profile",
  },
  {
    name: "tasks",
    description: "List Candy tasks",
  },
  {
    name: "use",
    argumentHint: "<task-id>",
    description: "Select a task",
  },
  {
    name: "transcript",
    argumentHint: "[task-id]",
    description: "Show a saved transcript",
  },
  {
    name: "resources",
    description: "Show Candy resource diagnostics",
  },
  {
    name: "prompts",
    description: "List Candy prompt templates",
  },
  {
    name: "prompt",
    argumentHint: "<name> [args]",
    description: "Run a Candy prompt template",
  },
  {
    name: "credentials",
    description: "Show credential presence",
  },
  {
    name: "credential",
    argumentHint: "set|replace|delete <provider>",
    description: "Manage a provider credential",
  },
  {
    name: "attach",
    argumentHint: "<path>",
    description: "Attach an image to the next task",
  },
  {
    name: "attachments",
    description: "List selected attachments",
  },
  {
    name: "trusted-shell",
    argumentHint: "on|off",
    description: "Configure Trusted Shell Auto",
  },
  {
    name: "shell",
    argumentHint: "on|off",
    description: "Alias for Trusted Shell Auto",
  },
  {
    name: "validator",
    argumentHint: "<executable> [args]",
    description: "Configure the task validator",
  },
  {
    name: "changes",
    description: "Show current task changes",
  },
  {
    name: "diff",
    argumentHint: "[path]",
    description: "Show a reviewed diff",
  },
  {
    name: "apply",
    description: "Apply reviewed task changes",
  },
  {
    name: "discard",
    description: "Discard a Candy task worktree",
  },
  {
    name: "validate",
    description: "Run the configured validator",
  },
  {
    name: "approve",
    argumentHint: "<approval-id>",
    description: "Approve a pending action",
  },
  {
    name: "deny",
    argumentHint: "<approval-id>",
    description: "Deny a pending action",
  },
  {
    name: "prioritize",
    argumentHint: "<task-id>",
    description: "Prioritize a queued task",
  },
  {
    name: "pause",
    argumentHint: "<task-id>",
    description: "Pause a task",
  },
  {
    name: "resume",
    argumentHint: "<task-id> <prompt>",
    description: "Continue a task with a new prompt",
  },
  {
    name: "steer",
    argumentHint: "<text>",
    description: "Queue steering for the active turn",
  },
  {
    name: "follow-up",
    argumentHint: "<text>",
    description: "Queue a follow-up for the active turn",
  },
  {
    name: "cancel",
    argumentHint: "<task-id>",
    description: "Cancel a task",
  },
  {
    name: "quit",
    description: "Exit Candy",
  },
];

/**
 * Provides only Candy slash commands. File completion would add an unneeded
 * filesystem discovery surface to the editor, so non-command input returns no
 * suggestions before Pi's combined provider can inspect a path.
 */
export function createCandySlashCommandAutocompleteProvider(): AutocompleteProvider {
  const commands = new CombinedAutocompleteProvider([...CANDY_SLASH_COMMANDS], ".");
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const currentLine = lines[cursorLine] ?? "";
      const beforeCursor = currentLine.slice(0, cursorCol);
      if (!beforeCursor.trimStart().startsWith("/")) return null;
      return commands.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return commands.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(): boolean {
      return false;
    },
  };
}
