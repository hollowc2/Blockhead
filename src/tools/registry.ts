import type { ToolDefinition } from "./types.js";

/**
 * Registry of the high-level tools the model may select. This is the only
 * boundary through which LLM output can reach Minecraft mechanics, so
 * unregistered tool names are rejected and arguments are zod-validated.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    if (this.tools.has(def.name)) {
      throw new Error(`tool already registered: ${def.name}`);
    }
    this.tools.set(def.name, def);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Compact JSON description injected into the decision prompt. */
  describe(): string {
    const list = [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      arguments: t.args,
    }));
    return JSON.stringify(list, null, 2);
  }

  /** Validate raw model arguments against a tool's schema; throws on mismatch. */
  validateArgs(name: string, args: unknown): Record<string, unknown> {
    const def = this.tools.get(name);
    if (!def) throw new Error(`unknown tool: ${name}`);
    if (!def.argsSchema) return (args ?? {}) as Record<string, unknown>;
    const parsed = def.argsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      throw new Error(`invalid arguments for ${name}: ${parsed.error.message}`);
    }
    return parsed.data as Record<string, unknown>;
  }
}
