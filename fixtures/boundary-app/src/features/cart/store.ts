const items = [{ price: 1200 }, { price: 450 }];
export const cartTotal = () => items.reduce((n, i) => n + i.price, 0);
