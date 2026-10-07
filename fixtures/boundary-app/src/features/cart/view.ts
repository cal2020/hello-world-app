import { cartTotal } from "./store";
import { money } from "../../shared/money";
export const CartView = () => money(cartTotal());
