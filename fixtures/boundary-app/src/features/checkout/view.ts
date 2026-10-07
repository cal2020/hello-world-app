import { money } from "../../shared/money";
// Boundary violation: checkout reaches straight into cart's internals.
import { cartTotal } from "../cart/store";
export const CheckoutView = () => `Pay ${money(cartTotal())}`;
