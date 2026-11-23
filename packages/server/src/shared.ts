export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
export const noop = () => {};
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
