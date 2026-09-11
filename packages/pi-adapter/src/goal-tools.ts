import * as piSdk from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

/*
 * Candy Goal Task tool bridge (P2).
 *
 * The durable goal state machine, validation, and tool semantics live in
 * `@candy/runtime` (`GoalToolHost`). This adapter only converts the neutral
 * goal tool descriptors into Pi tool definitions so the model can reach them
 * behind the Candy Tool Host. The bridge is structural: the adapter does not
 * depend on the runtime package, and `GoalToolHost` satisfies it as-is.
 */

/** One bounded goal tool argument as Candy declares it. */
export interface CandyGoalToolParameterSchema {
  readonly type: "string" | "integer" | "boolean";
  readonly description: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minimumLength?: number;
  readonly maximumLength?: number;
  readonly allowedValues?: readonly string[];
}

export interface CandyGoalToolDescriptor {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: readonly string[];
  readonly parameters: {
    readonly type: "object";
    readonly properties: Readonly<Record<string, CandyGoalToolParameterSchema>>;
    readonly required: readonly string[];
    readonly additionalProperties: false;
  };
}

export interface CandyGoalToolCallResult {
  readonly ok: boolean;
  /** Bounded, redacted, model-facing text; also used as the tool error text. */
  readonly text: string;
}

/**
 * Structural shape of Candy's goal tool host. `GoalToolHost` from
 * `@candy/runtime` satisfies it, and the TUI passes that instance straight in.
 */
export interface CandyGoalToolBridge {
  readonly definitions: readonly CandyGoalToolDescriptor[];
  call(request: {
    readonly name: string;
    readonly caller: "model" | "user";
    readonly arguments?: Readonly<Record<string, unknown>>;
  }): CandyGoalToolCallResult;
}

function goalParameterSchema(parameter: CandyGoalToolParameterSchema): TSchema {
  if (parameter.type === "boolean") return Type.Boolean({ description: parameter.description });
  if (parameter.type === "integer")
    return Type.Integer({
      description: parameter.description,
      ...(parameter.minimum === undefined ? {} : { minimum: parameter.minimum }),
      ...(parameter.maximum === undefined ? {} : { maximum: parameter.maximum }),
    });
  if (parameter.allowedValues !== undefined && parameter.allowedValues.length > 0)
    return Type.Union(parameter.allowedValues.map((value) => Type.Literal(value)));
  return Type.String({
    description: parameter.description,
    ...(parameter.minimumLength === undefined ? {} : { minLength: parameter.minimumLength }),
    ...(parameter.maximumLength === undefined ? {} : { maxLength: parameter.maximumLength }),
  });
}

/**
 * Convert Candy's goal tool set into Pi tool definitions. Execution always
 * routes back through the bridge with the `model` caller identity, so the
 * authority model (what the model may and may not change about a goal) stays
 * enforced in one place.
 */
export function createCandyGoalToolDefinitions(
  bridge: CandyGoalToolBridge,
): piSdk.ToolDefinition[] {
  return bridge.definitions.map((definition) => {
    const properties: Record<string, TSchema> = {};
    for (const [name, parameter] of Object.entries(definition.parameters.properties)) {
      const schema = goalParameterSchema(parameter);
      properties[name] = definition.parameters.required.includes(name)
        ? schema
        : Type.Optional(schema);
    }
    return {
      name: definition.name,
      label: definition.label,
      description: definition.description,
      promptSnippet: definition.promptSnippet,
      promptGuidelines: [...definition.promptGuidelines],
      parameters: Type.Object(properties, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (
        _toolCallId: string,
        input: Readonly<Record<string, unknown>> = {},
      ): Promise<{ content: readonly { readonly type: "text"; readonly text: string }[] }> => {
        const result = bridge.call({
          name: definition.name,
          caller: "model",
          arguments: input,
        });
        if (!result.ok) throw new Error(result.text);
        return { content: [{ type: "text" as const, text: result.text }] };
      },
    } as unknown as piSdk.ToolDefinition;
  });
}
