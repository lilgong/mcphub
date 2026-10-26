export const convertMcpbToMcpConfig = (manifest: any, extractPath: string, _serverName: string) => {
  const mcpConfig = manifest.server?.mcp_config || {};

  // Convert MCPB manifest to MCPHub stdio configuration
  const config: any = {
    type: 'stdio',
    command: mcpConfig.command || 'node',
    args: (mcpConfig.args || []).map((arg: string) => arg.replace('${__dirname}', extractPath)),
  };

  // Bundles may declare a longer request timeout for slow upstream tools.
  if (mcpConfig.options && typeof mcpConfig.options === 'object') {
    config.options = {};
    for (const field of ['timeout', 'maxTotalTimeout', 'maxBufferSize']) {
      const value = mcpConfig.options[field];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        config.options[field] = value;
      }
    }
    if (typeof mcpConfig.options.resetTimeoutOnProgress === 'boolean') {
      config.options.resetTimeoutOnProgress = mcpConfig.options.resetTimeoutOnProgress;
    }
  }

  // Add environment variables if they exist
  if (mcpConfig.env && Object.keys(mcpConfig.env).length > 0) {
    config.env = { ...mcpConfig.env };

    // Replace ${__dirname} in environment variables
    Object.keys(config.env).forEach((key) => {
      if (typeof config.env[key] === 'string') {
        config.env[key] = config.env[key].replace('${__dirname}', extractPath);
      }
    });
  }

  return config;
};
