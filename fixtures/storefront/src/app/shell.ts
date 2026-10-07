import { theme } from "../ui/theme";
import type { Route } from "./routes";
export function createApp(routes: Route[]) {
  return { mount: (sel: string) => console.log(`mounted ${routes.length} routes on ${sel} with ${theme.name}`) };
}
