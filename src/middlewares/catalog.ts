import type { RequestHandler } from 'express';
import { getServerDao } from '../dao/index.js';
import { serverKey } from '../utils/catalog.js';
import { validateBearerAuth } from '../services/sseService.js';
import { authorizationService } from '../services/authorizationService.js';

/** Resolve before authentication so all existing scope/session checks use the exact key. */
export const catalogRouteMiddleware: RequestHandler = async (req, res, next) => {
  const route = req.params.group;
  if (route?.includes('::')) {
    res.status(404).json({ error: 'MCP route not found' });
    return;
  }
  if (!route || route === '$smart' || route.startsWith('$smart/')) return next();
  if (!route.includes('/') && !route.includes('::')) return next();
  const parts = route.replace(/\/$/, '').split('/');
  if (parts.length !== 2 || parts.some((part) => !part)) {
    res.status(404).json({ error: 'MCP route not found' });
    return;
  }
  let key: string;
  try {
    key = serverKey(parts[1], parts[0]);
  } catch {
    res.status(404).json({ error: 'MCP route not found' });
    return;
  }
  try {
    req.params.group = key;
    // Resolve scope before auth, but never reveal registration existence to anonymous callers.
    // The transport handler remains responsible for the normal authentication error response.
    const authentication = await validateBearerAuth(req);
    if (!authentication.valid) return next();
    // No public fallback, catalog-wide aggregation, or accidental legacy group lookup.
    const server = await getServerDao().findById(key);
    if (
      !server ||
      server.enabled === false ||
      (authentication.user &&
        !authorizationService.can('server.discover', server, authentication.user))
    ) {
      res.status(404).json({ error: 'MCP route not found' });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
};
