import { lines } from "./cartStore";
import { Price } from "../../ui/Price";
import { cartTotal } from "./pricing";
export const CartPage = () => `${lines().length} items, total ${Price(cartTotal())}`;
