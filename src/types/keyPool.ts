/** Keys remain configured while temporary runtime cooldowns expire automatically. */
export interface KeyPoolConfig {
  enabled: boolean;
  provider: 'context7' | 'twelvedata';
  keys: { id: string; label?: string; value: string }[];
}
export interface KeyPoolResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
