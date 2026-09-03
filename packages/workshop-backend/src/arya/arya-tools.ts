// Read-only tool registry for the Arya voice assistant. PR 2 ships only side-effect-free tools so
// the Gemini Live function-calling seam can be proven before mutating tools land behind a
// confirmation gate in PR 4.

import type { AryaAiBackend, AryaAiState } from "./arya-types";

/** A function call requested by the AI model. */
export interface AryaToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** The result of executing one tool call. `response` is what gets sent back to the model. */
export interface AryaToolResult {
  id: string;
  name: string;
  response: unknown;
}

/** Runtime hooks the read-only tools are allowed to touch. */
export interface AryaToolRuntime {
  now(): Date;
  voiceStatus(): { state: AryaAiState; backend?: AryaAiBackend };
}

/** A tool the Arya assistant can execute. */
export interface AryaToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, runtime: AryaToolRuntime): unknown | Promise<unknown>;
}

/** Gemini function declaration shape (subset the Live API accepts). */
export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/** A single Gemini tool entry. */
export interface GeminiTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
}

/** Build the Gemini tools array from tool definitions (empty when there are none). */
export function geminiFunctionDeclarations(tools: AryaToolDefinition[]): GeminiTool[] {
  if (tools.length === 0) return [];
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    },
  ];
}

const DEFAULT_ARYA_TOOLS: AryaToolDefinition[] = [
  {
    name: "get_current_time",
    description: "Return the current date and time as an ISO-8601 string.",
    parameters: { type: "object", properties: {} },
    execute: (_args, runtime) => ({ time: runtime.now().toISOString() }),
  },
  {
    name: "get_voice_status",
    description: "Return the live state of the Arya voice assistant.",
    parameters: { type: "object", properties: {} },
    execute: (_args, runtime) => runtime.voiceStatus(),
  },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Execute a single tool call against the given runtime. Never throws. */
export async function executeAryaTool(
  call: AryaToolCall,
  runtime: AryaToolRuntime,
): Promise<AryaToolResult> {
  const tool = DEFAULT_ARYA_TOOLS.find((candidate) => candidate.name === call.name);
  if (!tool) {
    return {
      id: call.id,
      name: call.name,
      response: { ok: false, error: "Unknown tool: " + call.name },
    };
  }
  try {
    const result = await tool.execute(call.args, runtime);
    return { id: call.id, name: call.name, response: { ok: true, result } };
  } catch (error) {
    return { id: call.id, name: call.name, response: { ok: false, error: errorMessage(error) } };
  }
}

/** Registry that owns the built-in read-only tool set. */
export class AryaToolRegistry {
  constructor(private readonly runtime: AryaToolRuntime) {}

  definitions(): AryaToolDefinition[] {
    return DEFAULT_ARYA_TOOLS;
  }

  execute(call: AryaToolCall): Promise<AryaToolResult> {
    return executeAryaTool(call, this.runtime);
  }
}
