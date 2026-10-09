import { RequestContextService } from './requestContextService.js';
import type { InvocationLabels } from '../types/targetConnection.js';
export function invocationLabels(
  headers = RequestContextService.getInstance().getHeaders(),
): InvocationLabels {
  const read = (key: string) => {
    const value = headers?.[key];
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : undefined;
  };
  return {
    target: read('x-mcphub-target'),
    taskId: read('x-mcphub-task-id'),
  };
}
