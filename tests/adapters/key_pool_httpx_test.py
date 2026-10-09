"""Exercise the actual Python preload without making external requests."""
import asyncio
import json
import os
import runpy
import sys
import unittest
from unittest.mock import patch, AsyncMock
import httpx

PRELOAD = sys.argv.pop(1)

class AdapterTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.status = 200
        def send(client, request, **kwargs):
            self.calls.append(request)
            self.assertEqual(request.url.host, '127.0.0.1')
            return httpx.Response(self.status, json={'status': 200, 'headers': {'content-type': 'application/json'}, 'body': '{"price":"123"}'}, request=request)
        async def send_async(client, request, **kwargs):
            return send(client, request, **kwargs)
        self.sync = patch.object(httpx.Client, 'send', send)
        self.async_patch = patch.object(httpx.AsyncClient, 'send', send_async)
        self.environment = patch.dict(os.environ, {'MCPHUB_KEY_POOL_URL': 'http://127.0.0.1/internal/v1/key-pool/twelvedata', 'MCPHUB_KEY_POOL_TOKEN': 'test-capability'})
        self.sync.start(); self.async_patch.start(); self.environment.start()
        runpy.run_path(PRELOAD)
    def tearDown(self):
        self.sync.stop(); self.async_patch.stop(); self.environment.stop()
    def test_sync(self):
        with httpx.Client() as client:
            response = client.get('https://api.twelvedata.com/price?symbol=AAPL&apikey=placeholder')
            self.assertEqual(response.json(), {'price': '123'})
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0].headers['authorization'], 'Bearer test-capability')
        self.assertIn('symbol=AAPL', json.loads(self.calls[0].content)['url'])
    def test_async(self):
        async def check():
            async with httpx.AsyncClient() as client:
                response = await client.get('https://api.twelvedata.com/price?symbol=AAPL')
                self.assertEqual(response.json(), {'price': '123'})
        asyncio.run(check())
        self.assertEqual(len(self.calls), 1)
    def test_local_failure_does_not_fall_back_to_upstream(self):
        self.status = 502
        with httpx.Client() as client:
            with self.assertRaisesRegex(RuntimeError, 'key pool request failed'):
                client.get('https://api.twelvedata.com/price?symbol=AAPL')
        self.assertEqual(len(self.calls), 1)
    def test_only_invalid_optional_output_schemas_are_removed(self):
        from mcp.server.fastmcp import FastMCP
        from mcp.types import Tool
        tools = [Tool(name='array-tool', inputSchema={'type': 'object'}, outputSchema={'type': 'array'}), Tool(name='object-tool', inputSchema={'type': 'object'}, outputSchema={'type': 'object'})]
        with patch.object(FastMCP, 'list_tools', AsyncMock(return_value=tools)), patch.dict(os.environ, {'MCPHUB_TWELVEDATA_COMPAT': 'true'}):
            runpy.run_path(PRELOAD)
            result = asyncio.run(FastMCP.list_tools(object()))
            self.assertIsNone(result[0].outputSchema)
            self.assertEqual(result[1].outputSchema, {'type': 'object'})
            self.assertEqual(result[0].inputSchema, {'type': 'object'})
    def test_writes_rejected(self):
        with httpx.Client() as client:
            with self.assertRaisesRegex(RuntimeError, 'read-only'):
                client.post('https://api.twelvedata.com/write')
        self.assertEqual(self.calls, [])

if __name__ == '__main__': unittest.main()
