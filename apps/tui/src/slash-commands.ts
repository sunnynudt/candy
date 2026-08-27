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

export interface CandySkillSlashCommand {
  readonly name: string;
  readonly description: string;
}

const CANDY_SKILL_SLASH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function isCandySkillSlashCommandName(name: string): boolean {
  return CANDY_SKILL_SLASH_NAME_PATTERN.test(name);
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
    value: "deepseek-flash-vision",
    label: "deepseek-flash-vision",
    description: "DeepSeek V4 Flash Vision (experimental, multimodal)",
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

/**
 * The default completion for a bare `/model` preserves its documented query
 * behavior. A concrete model still requires an explicit selection.
 */
const BARE_MODEL_QUERY_ITEM: AutocompleteItem = {
  value: "",
  label: "查看当前模型",
  description: "显示当前模型与全部可选项",
};

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
    name: "plan",
    argumentHint: "[prompt]",
    description: "Create a read-only planning task; review the plan, then /build to implement",
  },
  {
    name: "build",
    argumentHint: "[task-id]",
    description: "Continue a reviewed plan task with the current profile to implement the plan",
  },
  {
    name: "debug",
    argumentHint: "[prompt]",
    description: "Create an Auto Debug task: model turn + validator until pass, stall, or budget",
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
    description: "Isolated Task Worktree for Auto Git tasks (default on; use off to edit directly)",
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
    name: "skills",
    description: "List Candy-owned skills",
  },
  {
    name: "skill",
    argumentHint: "<name> [prompt]",
    description: "Run a Candy skill with an optional goal",
    requiredArgument: true,
    usage: "/skill <name> [prompt]",
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
    name: "local",
    argumentHint: "on|off",
    description: "Toggle offline local commands for future isolated Auto Git tasks (default on)",
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
    name: "undo",
    argumentHint: "[task-id]",
    description: "Restore the latest turn checkpoint of an isolated (worktree) task",
  },
  {
    name: "checkpoints",
    description: "List undo checkpoints of the current task",
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
 * Commands that own a `getArgumentCompletions` callback are indexed by name so
 * the autocomplete provider can surface their argument list the moment the user
 * finishes typing the bare command name (for example `/model`), without forcing
 * an extra space keystroke before the choice list appears.
 */
function buildArgumentCompletionIndex(
  commands: readonly CandySlashCommand[],
): Map<string, CandySlashCommand> {
  const index = new Map<string, CandySlashCommand>();
  for (const command of commands) {
    if (typeof command.getArgumentCompletions === "function") {
      index.set(command.name, command);
    }
  }
  return index;
}

/** True when the provider should redirect a bare `/<cmd>` input to its arguments. */
function isBareCommandPrefix(prefix: string): boolean {
  return prefix.startsWith("/") && !prefix.includes(" ") && !prefix.slice(1).includes("/");
}

/**
 * Provides Candy-owned commands and loaded skill aliases. File completion would
 * add an unneeded filesystem discovery surface to the editor, so non-command
 * input returns no suggestions before Pi's combined provider can inspect a path.
 */
export function createCandySlashCommandAutocompleteProvider(
  workspacePath: () => string = () => process.cwd(),
  skills: readonly CandySkillSlashCommand[] = [],
): AutocompleteProvider {
  const builtInNames = new Set(CANDY_SLASH_COMMANDS.map((command) => command.name));
  const skillCommands: CandySlashCommand[] = skills
    .filter((skill) => isCandySkillSlashCommandName(skill.name) && !builtInNames.has(skill.name))
    .map((skill) => ({
      name: skill.name,
      description: `Skill — ${skill.description}`,
    }));
  const commands = new CombinedAutocompleteProvider(
    [...CANDY_SLASH_COMMANDS, ...skillCommands],
    ".",
  );
  const mentions = createWorkspaceMentionAutocompleteProvider(workspacePath);
  const argumentCompletionCommands = buildArgumentCompletionIndex([
    ...CANDY_SLASH_COMMANDS,
    ...skillCommands,
  ]);
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
      // Surface the argument list as soon as the user finishes typing a known
      // command name (e.g. `/model`) so the model chooser appears without an
      // extra space. The combined provider only enters the argument path
      // after it sees a space delimiter.
      const trimmed = beforeCursor.trimStart();
      if (!trimmed.includes(" ")) {
        const commandName = trimmed.slice(1);
        const command = argumentCompletionCommands.get(commandName);
        if (command?.getArgumentCompletions) {
          const items = await command.getArgumentCompletions("");
          if (Array.isArray(items) && items.length > 0) {
            // The full `/<cmd>` is the prefix so `applyCompletion` preserves the
            // command name and inserts a space before the chosen argument.
            return {
              items: commandName === "model" ? [BARE_MODEL_QUERY_ITEM, ...items] : items,
              prefix: trimmed,
            };
          }
        }
      }
      return commands.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (prefix.startsWith("@"))
        return mentions.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      // Only handle the bare-command completion when the prefix names a command
      // that owns argument completions; otherwise the combined provider still
      // owns the slash command-name completion path (e.g. "/mo" → "model").
      if (isBareCommandPrefix(prefix) && argumentCompletionCommands.has(prefix.slice(1))) {
        const currentLine = lines[cursorLine] ?? "";
        const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
        const afterCursor = currentLine.slice(cursorCol);
        const newLine = `${beforePrefix}${prefix} ${item.value}${afterCursor}`;
        const newLines = [...lines];
        newLines[cursorLine] = newLine;
        return {
          lines: newLines,
          cursorLine,
          cursorCol: beforePrefix.length + prefix.length + 1 + item.value.length,
        };
      }
      return commands.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol): boolean {
      return mentions.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
    },
  };
}
