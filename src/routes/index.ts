import { serverWorkspaceAccounts } from '../controllers/workspaceController.js';
import {
  workspaceManagement,
  createWorkspaceRun,
  workspaceRun,
} from '../controllers/workspaceController.js';
import { getRuntimeWorkers } from '../controllers/runtimeWorkerController.js';
import { forwardHttp } from '../controllers/httpForwardController.js';
import {
  relayRuntime,
  startRelay,
  stopRelay,
  resetRelayToken,
} from '../controllers/relayRuntimeController.js';
import {
  getUserGroups,
  saveUserGroup,
  getGroupResources,
} from '../controllers/userGroupController.js';
import { connectionRuntime } from '../controllers/connectionRuntimeController.js';
import { callStats } from '../controllers/callStatsController.js';
import {
  registerTaskConnection,
  renewTaskConnection,
  removeTaskConnection,
  dispatchTaskConnection,
} from '../controllers/taskConnectionController.js';
import { forwardKeyPool } from '../controllers/keyPoolController.js';
import { getCallLogs, getLogCatalogs } from '../controllers/logController.js';
import {
  relayLimits,
  getAtlasSettings,
  updateAtlasSettings,
  checkAtlasRelay,
  getAtlasRelayRuntime,
} from '../controllers/atlasController.js';
import {
  listMyCredentials,
  updateMyCredential,
} from '../controllers/credentialBindingController.js';
import express from 'express';
import { check } from 'express-validator';
import config from '../config/index.js';
import {
  getAllServers,
  getCatalogs,
  getAllSettings,
  getServerConfig,
  getServerShareCandidates,
  createServer,
  batchCreateServers,
  previewOpenApiToolStatsHandler,
  updateServer,
  deleteServer,
  toggleServer,
  reloadServer,
  reinstallServerHandler,
  disconnectServerOAuth,
  clearCache,
  toggleTool,
  updateToolDescription,
  resetToolDescription,
  togglePrompt,
  updatePromptDescription,
  resetPromptDescription,
  toggleResource,
  updateResourceDescription,
  resetResourceDescription,
  updateSystemConfig,
} from '../controllers/serverController.js';
import {
  getServerCostsHandler,
  getGroupCostsHandler,
} from '../controllers/contextCostController.js';
import {
  getSmartRoutingPerformance,
  reindexSmartRouting,
} from '../controllers/smartRoutingController.js';
import {
  getGroups,
  getGroup,
  createNewGroup,
  getGroupShareCandidates,
  batchCreateGroups,
  updateExistingGroup,
  deleteExistingGroup,
  addServerToExistingGroup,
  removeServerFromExistingGroup,
  getGroupServers,
  updateGroupServersBatch,
  getGroupServerConfigs,
  getGroupServerConfig,
  updateGroupServerTools,
} from '../controllers/groupController.js';
import {
  getUsers,
  getUser,
  createUser,
  updateExistingUser,
  deleteExistingUser,
  getUserStats,
} from '../controllers/userController.js';
import {
  getAllMarketServers,
  getMarketServer,
  getAllMarketCategories,
  getAllMarketTags,
  searchMarketServersByQuery,
  getMarketServersByCategory,
  getMarketServersByTag,
} from '../controllers/marketController.js';
import {
  getAllCloudServers,
  getCloudServer,
  getAllCloudCategories,
  getAllCloudTags,
  searchCloudServersByQuery,
  getCloudServersByCategory,
  getCloudServersByTag,
  getCloudServerToolsList,
  callCloudTool,
} from '../controllers/cloudController.js';
import {
  getAllRegistryServers,
  getRegistryServerVersions,
  getRegistryServerVersion,
} from '../controllers/registryController.js';
import { getChangelogUpdateInfoHandler } from '../controllers/changelogController.js';
import {
  listDiscoveryServers,
  getDiscoveryServer,
  getDiscoveryServerInstall,
  listDiscoveryCategories,
  listDiscoveryTags,
  getMarketplaceWellKnown,
} from '../controllers/discoveryController.js';
import { login, register, getCurrentUser, changePassword } from '../controllers/authController.js';
import { getAllLogs, clearLogs, streamLogs } from '../controllers/logController.js';
import {
  getRuntimeConfig,
  getPublicConfig,
  getMcpSettingsJson,
} from '../controllers/configController.js';
import { callTool } from '../controllers/toolController.js';
import { getPrompt } from '../controllers/promptController.js';
import {
  listBuiltinPrompts,
  getBuiltinPrompt,
  createBuiltinPrompt,
  updateBuiltinPrompt,
  deleteBuiltinPrompt,
} from '../controllers/builtinPromptController.js';
import {
  listBuiltinResources,
  getBuiltinResource,
  createBuiltinResource,
  updateBuiltinResource,
  deleteBuiltinResource,
  readResource,
} from '../controllers/builtinResourceController.js';
import { uploadMcpbFile, uploadMiddleware } from '../controllers/mcpbController.js';
import { healthCheck } from '../controllers/healthController.js';
import { getBetterAuthUser } from '../controllers/betterAuthController.js';
import {
  getOpenAPISpec,
  getOpenAPIServers,
  getOpenAPIStats,
  executeToolViaOpenAPI,
  getGroupOpenAPISpec,
} from '../controllers/openApiController.js';
import { handleOAuthCallback } from '../controllers/oauthCallbackController.js';
import {
  getAuthorize,
  postAuthorize,
  postToken,
  getUserInfo,
  getMetadata,
  getProtectedResourceMetadata,
} from '../controllers/oauthServerController.js';
import {
  getAllClients,
  getClient,
  createClient,
  updateClient,
  deleteClient,
  regenerateSecret,
} from '../controllers/oauthClientController.js';
import {
  registerClient,
  getClientConfiguration,
  updateClientConfiguration,
  deleteClientRegistration,
} from '../controllers/oauthDynamicRegistrationController.js';
import {
  getBearerKeys,
  createBearerKey,
  updateBearerKey,
  deleteBearerKey,
} from '../controllers/bearerKeyController.js';
import {
  checkActivityAvailable,
  getActivities,
  getActivityById,
  getActivityStats,
  getActivityFilterOptions,
  deleteOldActivities,
} from '../controllers/activityController.js';
import {
  getHostedInternalRuntimeCatalog,
  receiveHostedInternalEvent,
} from '../controllers/hostedInternalController.js';
import {
  exportConfigTemplate,
  exportGroupAsTemplate,
  importConfigTemplate,
} from '../controllers/templateController.js';
import { auth } from '../middlewares/auth.js';
import { requireAdminMiddleware } from '../utils/requireAdmin.js';
import {
  getBetterAuthRuntimeConfig,
  setMountedSsoProviders,
} from '../services/betterAuthConfig.js';
import {
  authAttemptRateLimiter,
  authRegistrationRateLimiter,
  authenticatedRouteRateLimiter,
  hostedInternalEventRateLimiter,
  mcpConnectionRateLimiter,
  templateRateLimiter,
} from '../utils/rateLimit.js';

const router = express.Router();
const authenticatedRouter = express.Router();

export const initRoutes = async (app: express.Application): Promise<void> => {
  const isTestEnv =
    process.env.NODE_ENV === 'test' ||
    process.env.JEST_WORKER_ID !== undefined ||
    process.env.VITEST_WORKER_ID !== undefined;
  const betterAuthConfig = await getBetterAuthRuntimeConfig();

  if (betterAuthConfig.enabled && !isTestEnv) {
    const [
      { auth: betterAuth, ensureBetterAuthSchema, registeredSsoProviders },
      { toNodeHandler },
    ] = await Promise.all([import('../betterAuth.js'), import('better-auth/node')]);
    await ensureBetterAuthSchema();
    const betterAuthPath = `${config.basePath}${betterAuthConfig.basePath}`;
    app.all(`${betterAuthPath}`, toNodeHandler(betterAuth));
    app.all(`${betterAuthPath}/*`, toNodeHandler(betterAuth));
    setMountedSsoProviders(registeredSsoProviders);
  }

  // Health check endpoint (no auth required, accessible at /health)
  app.get('/health', healthCheck);
  const httpPrefix = config.basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  app.all(
    new RegExp(`^${httpPrefix}/http/([^/]+)(/.*)?$`),
    express.raw({ type: () => true, limit: '1mb' }),
    forwardHttp,
  );
  app.post(
    '/gateway/v1/tasks/:id/:operation',
    express.json({ limit: '1mb' }),
    dispatchTaskConnection,
  );
  app.post('/internal/v1/key-pool/:name', express.json({ limit: '32kb' }), forwardKeyPool);

  // Hosted data-plane webhook ingress. HMAC-authenticated by INTERNAL_API_SECRET.
  app.post('/internal/v1/events', hostedInternalEventRateLimiter, receiveHostedInternalEvent);
  app.get(
    '/internal/v1/hosted/runtime-catalog',
    hostedInternalEventRateLimiter,
    getHostedInternalRuntimeCatalog,
  );

  // OAuth callback endpoint (no auth required, public callback URL)
  app.get('/oauth/callback', mcpConnectionRateLimiter, handleOAuthCallback);

  // OAuth Authorization Server endpoints (no auth required for OAuth flow)
  app.get('/oauth/authorize', mcpConnectionRateLimiter, getAuthorize);
  app.post(
    '/oauth/authorize',
    express.urlencoded({ extended: true }),
    mcpConnectionRateLimiter,
    postAuthorize,
  );
  app.post(
    '/oauth/token',
    express.urlencoded({ extended: true }),
    mcpConnectionRateLimiter,
    postToken,
  ); // Public endpoint for token exchange
  app.get('/oauth/userinfo', mcpConnectionRateLimiter, getUserInfo); // Validates OAuth token
  app.get('/.well-known/oauth-authorization-server', mcpConnectionRateLimiter, getMetadata); // Public metadata endpoint
  app.get(
    '/.well-known/oauth-protected-resource',
    mcpConnectionRateLimiter,
    getProtectedResourceMetadata,
  ); // Public protected resource metadata

  // RFC 7591 Dynamic Client Registration endpoints (public for registration)
  app.post('/oauth/register', mcpConnectionRateLimiter, registerClient); // Register new OAuth client
  app.get('/oauth/register/:clientId', mcpConnectionRateLimiter, getClientConfiguration); // Read client configuration
  app.put('/oauth/register/:clientId', mcpConnectionRateLimiter, updateClientConfiguration); // Update client configuration
  app.delete('/oauth/register/:clientId', mcpConnectionRateLimiter, deleteClientRegistration); // Delete client registration

  authenticatedRouter.use(authenticatedRouteRateLimiter);
  // `authenticatedRouter` is mounted at the end of this function, after the public
  // routes below have been registered on `router`. The order matters: the limiter
  // above is a path-less `use`, so it runs for every request that reaches the
  // sub-router - including ones that match no authenticated route and only fall
  // through to a public route such as POST /api/auth/login. Mounting last lets
  // those public routes match first, so they are governed by their own limiters
  // instead of consuming the shared authenticated-route budget.

  // API routes protected by auth middleware in middlewares/index.ts and rate limited here
  authenticatedRouter.get('/servers/:name/accounts', serverWorkspaceAccounts);
  authenticatedRouter.get('/servers/:name/accounts/:account', serverWorkspaceAccounts);
  authenticatedRouter.put('/servers/:name/accounts/:account', serverWorkspaceAccounts);
  authenticatedRouter.get('/workspace-credentials', workspaceManagement);
  authenticatedRouter.post(
    '/workspace-credentials/:catalog/:workspace/release',
    workspaceManagement,
  );
  authenticatedRouter.put(
    '/workspace-credentials/:catalog/:workspace',
    express.json({ limit: '9mb' }),
    workspaceManagement,
  );
  authenticatedRouter.delete('/workspace-credentials/:catalog/:workspace', workspaceManagement);
  authenticatedRouter.post('/workspace-runs', createWorkspaceRun);
  authenticatedRouter.get('/workspace-runs/:id', workspaceRun);
  authenticatedRouter.put('/workspace-runs/:id', workspaceRun);
  authenticatedRouter.put(
    '/workspace-runs/:id/files',
    express.json({ limit: '9mb' }),
    workspaceRun,
  );
  authenticatedRouter.delete('/workspace-runs/:id', workspaceRun);
  authenticatedRouter.post('/task-connections', registerTaskConnection);
  authenticatedRouter.put('/task-connections/:id', renewTaskConnection);
  authenticatedRouter.delete('/task-connections/:id', removeTaskConnection);
  authenticatedRouter.get('/credentials', listMyCredentials);
  authenticatedRouter.put('/credentials/:name', updateMyCredential);
  authenticatedRouter.delete('/credentials/:name', updateMyCredential);
  authenticatedRouter.get('/relay/runtime', relayRuntime);
  authenticatedRouter.post('/relay/runtime/start', startRelay);
  authenticatedRouter.post('/relay/runtime/stop', stopRelay);
  authenticatedRouter.post('/relay/runtime/reset-token', resetRelayToken);
  authenticatedRouter.get('/relay/limits', relayLimits);
  authenticatedRouter.put('/relay/limits', relayLimits);
  authenticatedRouter.get('/relay/config', getAtlasSettings);
  authenticatedRouter.put('/relay/config', updateAtlasSettings);
  authenticatedRouter.post('/relay/health', checkAtlasRelay);
  authenticatedRouter.get('/atlas', getAtlasSettings);
  authenticatedRouter.put('/atlas', updateAtlasSettings);
  authenticatedRouter.post('/atlas/relay-health', checkAtlasRelay);
  app.get(`${config.basePath}/atlas/relay-runtime`, mcpConnectionRateLimiter, getAtlasRelayRuntime);
  authenticatedRouter.get('/catalogs', getCatalogs);
  authenticatedRouter.get('/servers', getAllServers);
  authenticatedRouter.get('/servers/:name/share-candidates', getServerShareCandidates);
  authenticatedRouter.get('/servers/:name/runtime', connectionRuntime);
  authenticatedRouter.get('/servers/:name', getServerConfig);
  authenticatedRouter.get('/settings', getAllSettings);
  authenticatedRouter.post('/servers', createServer);
  authenticatedRouter.post('/servers/batch', batchCreateServers);
  authenticatedRouter.post('/servers/openapi/tool-stats', previewOpenApiToolStatsHandler);
  authenticatedRouter.put('/servers/:name', updateServer);
  authenticatedRouter.delete('/servers/:name', deleteServer);
  authenticatedRouter.post('/servers/:name/toggle', toggleServer);
  authenticatedRouter.post('/servers/:name/reload', reloadServer);
  authenticatedRouter.post('/servers/:name/reinstall', reinstallServerHandler);
  authenticatedRouter.post('/servers/:name/oauth/disconnect', disconnectServerOAuth);
  authenticatedRouter.post('/servers/:serverName/tools/:toolName/toggle', toggleTool);
  authenticatedRouter.put(
    '/servers/:serverName/tools/:toolName/description',
    updateToolDescription,
  );
  authenticatedRouter.delete(
    '/servers/:serverName/tools/:toolName/description',
    resetToolDescription,
  );
  authenticatedRouter.post('/servers/:serverName/prompts/:promptName/toggle', togglePrompt);
  authenticatedRouter.put(
    '/servers/:serverName/prompts/:promptName/description',
    updatePromptDescription,
  );
  authenticatedRouter.delete(
    '/servers/:serverName/prompts/:promptName/description',
    resetPromptDescription,
  );
  authenticatedRouter.post('/servers/:serverName/resources/:resourceUri/toggle', toggleResource);
  authenticatedRouter.put(
    '/servers/:serverName/resources/:resourceUri/description',
    updateResourceDescription,
  );
  authenticatedRouter.delete(
    '/servers/:serverName/resources/:resourceUri/description',
    resetResourceDescription,
  );
  authenticatedRouter.put('/system-config', updateSystemConfig);
  authenticatedRouter.post('/cache/clear', clearCache);

  // Context Footprint cost routes
  authenticatedRouter.get('/cost/servers', getServerCostsHandler);
  authenticatedRouter.get('/cost/groups', getGroupCostsHandler);

  // Smart Routing diagnostics and maintenance
  authenticatedRouter.get('/smart-routing/performance', getSmartRoutingPerformance);
  authenticatedRouter.post('/smart-routing/reindex', reindexSmartRouting);

  // Group management routes
  authenticatedRouter.get('/groups', getGroups);
  authenticatedRouter.get('/groups/:id', getGroup);
  authenticatedRouter.get('/groups/:id/share-candidates', getGroupShareCandidates);
  authenticatedRouter.post('/groups', createNewGroup);
  authenticatedRouter.post('/groups/batch', batchCreateGroups);
  authenticatedRouter.put('/groups/:id', updateExistingGroup);
  authenticatedRouter.delete('/groups/:id', deleteExistingGroup);
  authenticatedRouter.post('/groups/:id/servers', addServerToExistingGroup);
  authenticatedRouter.delete('/groups/:id/servers/:serverName', removeServerFromExistingGroup);
  authenticatedRouter.get('/groups/:id/servers', getGroupServers);
  // New route for batch updating servers in a group
  authenticatedRouter.put('/groups/:id/servers/batch', updateGroupServersBatch);
  // New routes for server configurations and tool management in groups
  authenticatedRouter.get('/groups/:id/server-configs', getGroupServerConfigs);
  authenticatedRouter.get('/groups/:id/server-configs/:serverName', getGroupServerConfig);
  authenticatedRouter.put('/groups/:id/server-configs/:serverName/tools', updateGroupServerTools);

  // User management routes (admin only)
  authenticatedRouter.get('/users', getUsers);
  authenticatedRouter.get('/users/:username', getUser);
  authenticatedRouter.post('/users', createUser);
  authenticatedRouter.put('/users/:username', updateExistingUser);
  authenticatedRouter.delete('/users/:username', deleteExistingUser);
  authenticatedRouter.get('/users-stats', getUserStats);

  // OAuth Client management routes (admin only)
  authenticatedRouter.get('/oauth/clients', getAllClients);
  authenticatedRouter.get('/oauth/clients/:clientId', getClient);
  authenticatedRouter.post(
    '/oauth/clients',
    [
      check('name', 'Client name is required').not().isEmpty(),
      check('redirectUris', 'At least one redirect URI is required').isArray({ min: 1 }),
    ],
    createClient,
  );
  authenticatedRouter.put('/oauth/clients/:clientId', updateClient);
  authenticatedRouter.delete('/oauth/clients/:clientId', deleteClient);
  authenticatedRouter.post('/oauth/clients/:clientId/regenerate-secret', regenerateSecret);

  // Bearer authentication key management (admin only)
  authenticatedRouter.get('/runtime-workers', getRuntimeWorkers);
  authenticatedRouter.get('/user-groups', getUserGroups);
  authenticatedRouter.post('/user-groups', saveUserGroup);
  authenticatedRouter.get('/user-groups/resources', getGroupResources);
  authenticatedRouter.put('/user-groups/:id', saveUserGroup);
  authenticatedRouter.delete('/user-groups/:id', saveUserGroup);
  authenticatedRouter.get('/auth/keys', getBearerKeys);
  authenticatedRouter.post('/auth/keys', createBearerKey);
  authenticatedRouter.put('/auth/keys/:id', updateBearerKey);
  authenticatedRouter.delete('/auth/keys/:id', deleteBearerKey);

  // Activity routes (database mode only)
  authenticatedRouter.get('/activities/available', checkActivityAvailable);
  authenticatedRouter.get('/activities', getActivities);
  authenticatedRouter.get('/activities/stats', getActivityStats);
  authenticatedRouter.get('/activities/filters', getActivityFilterOptions);
  authenticatedRouter.get('/activities/:id', getActivityById);
  authenticatedRouter.delete('/activities/cleanup', deleteOldActivities);

  // Configuration template routes
  authenticatedRouter.post('/templates/export', templateRateLimiter, auth, exportConfigTemplate);
  authenticatedRouter.get(
    '/templates/export/groups/:id',
    templateRateLimiter,
    auth,
    exportGroupAsTemplate,
  );
  authenticatedRouter.post('/templates/import', templateRateLimiter, auth, importConfigTemplate);

  // Tool management routes
  authenticatedRouter.post('/tools/call/:server', callTool);

  // Prompt management routes
  authenticatedRouter.post('/mcp/:serverName/prompts/:promptName', getPrompt);

  // Built-in prompt management routes
  authenticatedRouter.get('/prompts', listBuiltinPrompts);
  authenticatedRouter.get('/prompts/:id', getBuiltinPrompt);
  authenticatedRouter.post('/prompts', createBuiltinPrompt);
  authenticatedRouter.put('/prompts/:id', updateBuiltinPrompt);
  authenticatedRouter.delete('/prompts/:id', deleteBuiltinPrompt);

  // Built-in resource management routes
  authenticatedRouter.get('/resources', listBuiltinResources);
  authenticatedRouter.get('/resources/:id', getBuiltinResource);
  authenticatedRouter.post('/resources', createBuiltinResource);
  authenticatedRouter.put('/resources/:id', updateBuiltinResource);
  authenticatedRouter.delete('/resources/:id', deleteBuiltinResource);
  authenticatedRouter.post('/resources/read', readResource);

  // MCPB upload routes. Admin-only: the handler replaces the code at the
  // deterministic `data/uploads/mcpb/server-<name>` path that existing stdio
  // server configurations point into, so an unprivileged upload would be a
  // second write path to the stdio execution boundary (GHSA-xf2m-3c3x-53vp).
  // The admin gate must run before `uploadMiddleware` so multer never stages a
  // non-admin upload body on disk.
  authenticatedRouter.post(
    '/mcpb/upload',
    requireAdminMiddleware,
    uploadMiddleware,
    uploadMcpbFile,
  );

  // Market routes
  authenticatedRouter.get('/market/servers', getAllMarketServers);
  authenticatedRouter.get('/market/servers/search', searchMarketServersByQuery);
  authenticatedRouter.get('/market/servers/:name', getMarketServer);
  authenticatedRouter.get('/market/categories', getAllMarketCategories);
  authenticatedRouter.get('/market/categories/:category', getMarketServersByCategory);
  authenticatedRouter.get('/market/tags', getAllMarketTags);
  authenticatedRouter.get('/market/tags/:tag', getMarketServersByTag);

  // Cloud Market routes
  authenticatedRouter.get('/cloud/servers', getAllCloudServers);
  authenticatedRouter.get('/cloud/servers/search', searchCloudServersByQuery);
  authenticatedRouter.get('/cloud/servers/:name', getCloudServer);
  authenticatedRouter.get('/cloud/categories', getAllCloudCategories);
  authenticatedRouter.get('/cloud/categories/:category', getCloudServersByCategory);
  authenticatedRouter.get('/cloud/tags', getAllCloudTags);
  authenticatedRouter.get('/cloud/tags/:tag', getCloudServersByTag);
  authenticatedRouter.get('/cloud/servers/:serverName/tools', getCloudServerToolsList);
  authenticatedRouter.post('/cloud/servers/:serverName/tools/:toolName/call', callCloudTool);

  // Registry routes (proxy to official MCP registry)
  authenticatedRouter.get('/registry/servers', getAllRegistryServers);
  authenticatedRouter.get('/registry/servers/versions', getRegistryServerVersions);
  authenticatedRouter.get('/registry/servers/version', getRegistryServerVersion);

  // Changelog routes (proxy to mcphub-web changelog API)
  authenticatedRouter.get('/changelog/update-info', getChangelogUpdateInfoHandler);

  // Log routes
  authenticatedRouter.get('/logs/catalogs', getLogCatalogs);
  authenticatedRouter.get('/logs/statistics', callStats);
  authenticatedRouter.get('/logs/calls', getCallLogs);
  authenticatedRouter.get('/logs', getAllLogs);
  authenticatedRouter.delete('/logs', clearLogs);
  authenticatedRouter.get('/logs/stream', streamLogs);

  // MCP settings export route
  authenticatedRouter.get('/mcp-settings/export', getMcpSettingsJson);

  // Better Auth user route requires authentication and shares the authenticated route limiter
  authenticatedRouter.get('/better-auth/user', getBetterAuthUser);

  router.post(
    '/auth/login',
    [
      check('username', 'Username is required').not().isEmpty(),
      check('password', 'Password is required').not().isEmpty(),
    ],
    authAttemptRateLimiter,
    login,
  );

  router.post(
    '/auth/register',
    [
      check('username', 'Username is required').not().isEmpty(),
      check('password', 'Password must be at least 6 characters').isLength({ min: 6 }),
    ],
    authRegistrationRateLimiter,
    register,
  );

  router.get('/auth/user', authenticatedRouteRateLimiter, auth, getCurrentUser);

  // Add change password route
  router.post(
    '/auth/change-password',
    authenticatedRouteRateLimiter,
    [
      auth,
      check('currentPassword', 'Current password is required').not().isEmpty(),
      check('newPassword', 'New password must be at least 6 characters').isLength({ min: 6 }),
    ],
    changePassword,
  );

  // Runtime configuration endpoint (no auth required for frontend initialization)
  app.get(`${config.basePath}/config`, getRuntimeConfig);

  // Public configuration endpoint (no auth required to check skipAuth setting)
  app.get(`${config.basePath}/public-config`, getPublicConfig);

  // Public marketplace discovery API (issue #809). Off by default; enable via
  // systemConfig.discovery.enabled. When disabled, all of these return 404 to
  // avoid leaking the catalog. Designed for external MCP clients (OpenClaw,
  // Claude Desktop installers, etc.) to programmatically find servers in the
  // local market without dashboard auth.
  app.get('/.well-known/mcp-marketplace', getMarketplaceWellKnown);
  app.get(`${config.basePath}/discovery/servers`, listDiscoveryServers);
  app.get(`${config.basePath}/discovery/servers/:name`, getDiscoveryServer);
  app.get(`${config.basePath}/discovery/servers/:name/install`, getDiscoveryServerInstall);
  app.get(`${config.basePath}/discovery/categories`, listDiscoveryCategories);
  app.get(`${config.basePath}/discovery/tags`, listDiscoveryTags);

  // OpenAPI generation endpoints
  app.get(`${config.basePath}/api/openapi.json`, getOpenAPISpec);
  app.get(`${config.basePath}/api/openapi.yaml`, getOpenAPISpec);
  app.get(`${config.basePath}/api/:name/openapi.json`, getGroupOpenAPISpec);
  app.get(`${config.basePath}/api/:name/openapi.yaml`, getGroupOpenAPISpec);
  app.get(`${config.basePath}/api/openapi/servers`, getOpenAPIServers);
  app.get(`${config.basePath}/api/openapi/stats`, getOpenAPIStats);

  // OpenAPI-compatible tool execution endpoints
  app.get(`${config.basePath}/api/tools/:serverName/:toolName`, executeToolViaOpenAPI);
  app.post(`${config.basePath}/api/tools/:serverName/:toolName`, executeToolViaOpenAPI);
  app.get(`${config.basePath}/api/:name/tools/:serverName/:toolName`, executeToolViaOpenAPI);
  app.post(`${config.basePath}/api/:name/tools/:serverName/:toolName`, executeToolViaOpenAPI);

  // Mounted last so the public routes registered on `router` above are matched
  // before the shared authenticated-route rate limiter runs. See the comment on
  // `authenticatedRouter.use(authenticatedRouteRateLimiter)`.
  router.use(authenticatedRouter);

  app.use(`${config.basePath}/api`, router);
};

export default router;
