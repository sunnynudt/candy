import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteProvider,
  type SlashCommand,
} from "@earendil-works/pi-tui";
import { createWorkspaceMentionAutocompleteProvider } from "./file-mentions.js";

/** A Candy slash command with optional usage metadata for /help and bare-command guards. */
export interface CandySlashCommand extends SlashCommand {
  /** True when the command is inert without its required argument. */
  readonly requiredArgument?: boolean;
  /** Canonical syntax shown by /help, including the leading "/". */
  readonly usage?: string;
}

export const CANDY_MODEL_CHOICES: readonly AutocompleteItem[] = [
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
    description: "MiniMax M3 (native image)",
  },
];

function completeModels(argumentPrefix: string): AutocompleteItem[] {
  const prefix = argumentPrefix.trim().toLowerCase();
  return CANDY_MODEL_CHOICES.filter((item: AutocompleteItem): boolean =>
    item.value.toLowerCase().startsWith(prefix),
  );
}

export const CANDY_SLASH_COMMANDS: readonly CandySlashCommand[] = [
  {
    name: "help",
    description: "Show the Candy command reference",
  },
  {
    name: "status",
    argumentHint: "[task-id]",
    description: "Show the current task status",
  },
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
    requiredArgument: true,
    usage: "/profile read-only|auto",
  },
  {
    name: "worktree",
    argumentHint: "on|off",
    description: "Opt into an isolated Task Worktree (default is direct workspace)",
    requiredArgument: true,
    usage: "/worktree on|off",
  },
  {
    name: "tasks",
    description: "List Candy tasks",
  },
  {
    name: "use",
    argumentHint: "<task-id>",
    description: "Select a task",
    requiredArgument: true,
    usage: "/use <task-id>",
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
    usage: "/credential set|replace|delete <deepseek|minimax-cn>",
  },
  {
    name: "attach",
    argumentHint: "<path>",
    description: "Attach an image to the next task",
    usage: "/attach <absolute-path>",
  },
  {
    name: "attachments",
    description: "List selected attachments",
  },
  {
    name: "trusted-shell",
    argumentHint: "on|off",
    description: "Enable Trusted Shell Auto (automatically enables Worktree)",
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
    requiredArgument: true,
    usage: "/approve <approval-id>",
  },
  {
    name: "deny",
    argumentHint: "<approval-id>",
    description: "Deny a pending action",
    requiredArgument: true,
    usage: "/deny <approval-id>",
  },
  {
    name: "prioritize",
    argumentHint: "<task-id>",
    description: "Prioritize a queued task",
    requiredArgument: true,
    usage: "/prioritize <task-id>",
  },
  {
    name: "pause",
    argumentHint: "<task-id>",
    description: "Pause a task",
    requiredArgument: true,
    usage: "/pause <task-id>",
  },
  {
    name: "resume",
    argumentHint: "<task-id> <prompt>",
    description: "Continue a task with a new prompt",
    requiredArgument: true,
    usage: "/resume <task-id> <continuation>",
  },
  {
    name: "steer",
    argumentHint: "<text>",
    description: "Queue steering for the active turn",
    requiredArgument: true,
    usage: "/steer <text>",
  },
  {
    name: "follow-up",
    argumentHint: "<text>",
    description: "Queue a follow-up for the active turn",
    requiredArgument: true,
    usage: "/follow-up <text>",
  },
  {
    name: "cancel",
    argumentHint: "<task-id>",
    description: "Cancel a task",
    requiredArgument: true,
    usage: "/cancel <task-id>",
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
export function createCandySlashCommandAutocompleteProvider(
  workspacePath: () => string = () => process.cwd(),
): AutocompleteProvider {
  const commands = new CombinedAutocompleteProvider([...CANDY_SLASH_COMMANDS], ".");
  const mentions = createWorkspaceMentionAutocompleteProvider(workspacePath);
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const currentLine = lines[cursorLine] ?? "";
      const beforeCursor = currentLine.slice(0, cursorCol);
      const mentionSuggestions = await mentions.getSuggestions(
        lines,
        cursorLine,
        cursorCol,
        options,
      );
      if (mentionSuggestions !== null) return mentionSuggestions;
      if (!beforeCursor.trimStart().startsWith("/")) return null;
      return commands.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (prefix.startsWith("@"))
        return mentions.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      return commands.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol): boolean {
      return mentions.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
    },
  };
}
