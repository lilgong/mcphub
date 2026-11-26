import { indexedToolStats } from './toolStatsIndexService.js';
export interface StatsQuery {
  start: string;
  end: string;
  server?: string;
  catalog?: string;
  credentialId?: string;
  metric?: string;
  timeZone?: string;
}
export interface ServerCallStats {
  server: string;
  catalog?: string;
  calls: number;
  success: number;
  errors: number;
  durationMs: number;
}
/** Only completed tool invocations count; internal HTTP attempts remain separate. */
export async function getCallStats(query: StatsQuery) {
  const directory = process.env.MCPHUB_AUDIT_LOG_DIR;
  if (!directory) return { rows: [], total: 0, success: 0, errors: 0, available: false };
  return indexedToolStats(directory, query);
}
