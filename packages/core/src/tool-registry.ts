import { ValidationError } from "./errors.js";
import type { AnyToolDefinition, ToolCollection, ToolRegistryLike, ToolSet } from "./types.js";

const cloneToolSet = (tools: ToolSet): ToolSet => ({ ...tools });
const isIterable = (value: unknown): value is Iterable<AnyToolDefinition> =>
  Boolean(value && typeof value === "object" && Symbol.iterator in value);

export const isToolRegistry = (value: unknown): value is ToolRegistryLike =>
  Boolean(
    value &&
      typeof value === "object" &&
      "toToolSet" in value &&
      typeof (value as ToolRegistryLike).toToolSet === "function"
  );

export const toToolSet = (input: ToolCollection | undefined): ToolSet | undefined => {
  if (!input) {
    return undefined;
  }

  return isToolRegistry(input) ? input.toToolSet() : cloneToolSet(input);
};

export class ToolRegistry implements ToolRegistryLike {
  private readonly tools = new Map<string, AnyToolDefinition>();

  constructor(initial?: ToolCollection | Iterable<AnyToolDefinition>) {
    if (!initial) {
      return;
    }

    if (isToolRegistry(initial)) {
      this.registerMany(initial.toToolSet());
      return;
    }

    if (isIterable(initial)) {
      for (const definition of initial) {
        this.register(definition);
      }
      return;
    }

    this.registerMany(initial as ToolSet);
  }

  register<TTool extends AnyToolDefinition>(definition: TTool): TTool {
    const existing = this.tools.get(definition.name);
    if (existing && existing !== definition) {
      throw new ValidationError(`Tool "${definition.name}" is already registered.`);
    }

    this.tools.set(definition.name, definition);
    return definition;
  }

  registerMany(input: ToolCollection | undefined): this {
    const toolSet = toToolSet(input);
    if (!toolSet) {
      return this;
    }

    for (const definition of Object.values(toolSet)) {
      this.register(definition);
    }

    return this;
  }

  merge(...inputs: Array<ToolCollection | undefined>): ToolRegistry {
    const merged = new ToolRegistry(this.toToolSet());
    for (const input of inputs) {
      merged.registerMany(input);
    }
    return merged;
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  entries(): Iterable<[string, AnyToolDefinition]> {
    return this.tools.entries();
  }

  values(): Iterable<AnyToolDefinition> {
    return this.tools.values();
  }

  toToolSet(): ToolSet {
    return Object.fromEntries(this.tools.entries());
  }
}

export const createToolRegistry = (
  initial?: ToolCollection | Iterable<AnyToolDefinition>
): ToolRegistry => new ToolRegistry(initial);
