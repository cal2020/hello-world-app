import { lines } from "../cart/cartStore";
import { validateAddress } from "./address";
import { track } from "./analytics";
export async function submitOrder(address: string) {
  validateAddress(address);
  track("checkout", { items: lines().length });
}
