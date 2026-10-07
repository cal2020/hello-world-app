import type { User } from "../data/user";
import { titleCase } from "../lib/text";

export function renderGreeting(user: User): string {
  return `Hello, ${titleCase(user.name)}!`;
}
