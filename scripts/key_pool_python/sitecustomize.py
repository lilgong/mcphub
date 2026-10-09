"""Intercept read-only TwelveData HTTP requests in Hub-managed Python MCPs."""
import os

if os.environ.get("MCPHUB_KEY_POOL_URL"):
    import httpx

    _sync_send = httpx.Client.send
    _async_send = httpx.AsyncClient.send

    def _target(request):
        return request.url.host == "api.twelvedata.com"

    def _response(result, request):
        return httpx.Response(result["status"], headers=result["headers"], content=result["body"].encode(), request=request)

    def _options(request):
        if request.method != "GET":
            raise RuntimeError("Key pool only supports read-only TwelveData requests")
        return {"url": os.environ["MCPHUB_KEY_POOL_URL"], "headers": {"Authorization": "Bearer " + os.environ["MCPHUB_KEY_POOL_TOKEN"]}, "json": {"url": str(request.url)}}

    def _send(client, request, **kwargs):
        if not _target(request):
            return _sync_send(client, request, **kwargs)
        with httpx.Client(timeout=60, trust_env=False) as local:
            response = local.post(**_options(request))
            if not response.is_success:
                raise RuntimeError("TwelveData key pool request failed")
            return _response(response.json(), request)

    async def _send_async(client, request, **kwargs):
        if not _target(request):
            return await _async_send(client, request, **kwargs)
        async with httpx.AsyncClient(timeout=60, trust_env=False) as local:
            response = await local.post(**_options(request))
            if not response.is_success:
                raise RuntimeError("TwelveData key pool request failed")
            return _response(response.json(), request)

    httpx.Client.send = _send
    httpx.AsyncClient.send = _send_async

if os.environ.get("MCPHUB_TWELVEDATA_COMPAT") == "true":
    from mcp.server.fastmcp import FastMCP

    _list_tools = FastMCP.list_tools

    async def _compatible_list_tools(server):
        tools = await _list_tools(server)
        for tool in tools:
            # MCP outputSchema is optional, but if present it must be an object.
            if tool.outputSchema and tool.outputSchema.get("type") != "object":
                tool.outputSchema = None
        return tools

    FastMCP.list_tools = _compatible_list_tools
