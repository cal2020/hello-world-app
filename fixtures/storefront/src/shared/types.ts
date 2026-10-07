export interface Product { id: string; name: string; priceCents: number }
export interface Order { id: string; items: { productId: string; qty: number }[] }
export interface CartLine { product: Product; qty: number }
