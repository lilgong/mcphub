export interface RelayRuntimeStatus {
  state: 'running' | 'external' | 'stopped' | 'failed';
  healthy: boolean;
  configured: boolean;
  missing: string[];
  port: number;
  pid?: number;
  lastError?: string;
}
