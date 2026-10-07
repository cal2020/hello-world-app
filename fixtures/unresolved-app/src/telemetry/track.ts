// This file was deleted in a refactor; the import was left behind.
import { send } from "./transport";
export function track(event: string) {
  send({ event, at: Date.now() });
}
