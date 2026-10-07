import { formatMoney } from "../shared/money";
export const Price = (cents: number) => `<span class="price">${formatMoney(cents)}</span>`;
