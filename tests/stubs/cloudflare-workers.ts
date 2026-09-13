/** Minimal node-side stub so tests can import modules that touch cloudflare:workers. */
export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  ctx?: unknown;
  env?: Env;
  constructor(..._args: unknown[]) {
    void _args;
  }
  async run(_event: { timestamp: number; payload?: Params }, _step: unknown): Promise<unknown> {
    return undefined;
  }
}
export type WorkflowEvent<T = unknown> = { timestamp: number; payload?: T };
export interface WorkflowStep {
  do: <T>(name: string, cb: () => Promise<T> | T) => Promise<T>;
  sleep: (name: string, ms: number) => Promise<void>;
  waitForEvent: <T>(name: string, opts?: unknown) => Promise<T>;
}
