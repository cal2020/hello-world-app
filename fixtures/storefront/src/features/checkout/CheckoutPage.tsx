import { Button } from "../../ui/Button";
import { submitOrder } from "./submitOrder";
export const CheckoutPage = () => `${Button("Pay")} ${typeof submitOrder}`;
