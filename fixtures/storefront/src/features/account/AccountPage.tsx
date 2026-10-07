import { listOrders } from "../../api/orders";
import { formatMoney } from "../../shared/money";
import type { Order } from "../../shared/types";
let orders: Order[] = [];
void listOrders().then((o) => (orders = o));
export const AccountPage = () => `${orders.length} orders · credit ${formatMoney(0)}`;
