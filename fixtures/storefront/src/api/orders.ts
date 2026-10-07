import { get } from "./client";
import type { Order } from "../shared/types";
export const listOrders = () => get<Order[]>("/orders");
