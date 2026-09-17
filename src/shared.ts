export type Mode = 'rp' | 'coding';
export type JobStatus = 'running' | 'complete' | 'cancelled' | 'failed' | 'interrupted';
export interface Conversation { id: string; title: string; mode: Mode; revision: number; project: string | null; trusted: number; created: string }
export interface Message { id: number; conversation: string; role: 'user' | 'assistant'; content: string; revision: number; edited?: string | null }
export interface Action { tool: string; status: 'running' | 'complete' | 'failed'; output: string }
export interface Job { id: string; conversation: string; status: JobStatus; text: string; error: string; actions: Action[]; revision: number; created: string }
export type Dialect = 'chat-completions' | 'responses' | 'anthropic' | 'gemini' | 'speech';
export type AuthMode = 'auto' | 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'xi-api-key' | 'none';
export type Route = 'auto' | 'direct' | 'tor' | 'i2p' | 'proxy';
export interface Connection { endpoint: string; model: string; route: Route; proxyUrl?: string; dialect: Dialect; provider?: string; variant?: string; region?: string; credentialId?: string; profileId?: string; hasKey?: boolean; demo?: boolean; name?: string; auth?: AuthMode }
export interface ProviderMessage { role: string; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; native?: any[]; reasoning_content?: string; reasoning_details?: any[] }
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export class AppError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
export function requireString(value: unknown, name: string, max = 16000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(`Invalid ${name}.`);
  return value;
}
