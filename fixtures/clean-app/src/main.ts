import { renderGreeting } from "./ui/greeting";
import { loadUser } from "./data/user";

export function main(): string {
  return renderGreeting(loadUser());
}
