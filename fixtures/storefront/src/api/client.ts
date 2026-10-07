import { config } from "../shared/config";
export async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${config.apiBase}${path}`);
  return (await res.json()) as T;
}
