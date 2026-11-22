export type CommandStatus = "new" | "pending" | "processed";

export interface OrderLine {
  command_id?: string;
  article_id: string;
  article_name: string;
  quantity: number;
  daily_price: number;
  product_id?: string;
}

export interface Command {
  id: string;
  command_id?: string;
  recorded_at: string;
  client_id: string;
  client_name?: string;
  phone_number?: string;
  delivery_date?: string;
  status?: CommandStatus;
  approved?: boolean | null;
  order_lines: OrderLine[];
}

export interface Product {
  product_id: string;
  article_id?: string;
  article_name: string;
  price: number;
  stock: number;
}

export interface Purchase {
  id: string;
  command_id?: string;
  product_id: string;
  article_name?: string;
  client_id?: string;
  client_name?: string;
  quantity: number;
  price: number;
  recorded_at?: string;
  approved?: boolean | null;
}

export interface ClientStats {
  client_id: string;
  client_name?: string;
  phone_number?: string;
  command_count: number;
  total_spent: number;
}

export interface Paginated<T> {
  items: T[];
  total?: number;
  page?: number;
  size?: number;
}
