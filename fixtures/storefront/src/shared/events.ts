type Handler = (payload: unknown) => void;
const handlers = new Map<string, Handler[]>();
export const on = (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]);
export const emit = (name: string, payload: unknown) => handlers.get(name)?.forEach((h) => h(payload));
