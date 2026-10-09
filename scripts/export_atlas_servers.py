#!/usr/bin/env python3
"""Export Atlas's pinned shared MCP definitions, never importing its .env keys."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ISOLATED = {
    "filesystem", "git", "memory", "mongodb", "cli-mcp-server",
    "desktop-commander", "mcp-code-executor", "mcp-server-code-runner", "arxiv", "pubmed",
}
WEATHER_REVISION = "3474c7841d00f5f40c087c5d2188a5c0f41bd134"
POLICY_PRESETS = {
    "brave-search": {"enabled": True, "minIntervalMs": 1500},
    "twelvedata": {"enabled": True, "minIntervalMs": 8000, "maxCalls": 8, "windowMs": 60000},
}
DEFAULT_SERVERS = "brave-search,exa,lara-translate,weather-data,oxylabs"


def export_servers(atlas: Path, names: list[str]) -> dict:
    template = json.loads((atlas / "services/agent-environment/src/agent_environment/mcp_server_template.json").read_text())["mcpServers"]
    if not names or set(names) - set(template) or set(names) & ISOLATED:
        raise ValueError("Select existing shared MCP servers; isolated task servers cannot be exported")
    lock = json.loads((atlas / "services/agent-environment/package-lock.json").read_text())["packages"]
    result = {}
    for name in names:
        # Resolve no environment variables: secrets must be supplied in Hub's UI.
        server = json.loads(re.sub(r"\$\{[^}]+\}", "", json.dumps(template[name])))
        if isinstance(server.get("env"), list):
            server["env"] = server["env"][0]
        if server["command"] == "npx":
            arguments = [item for item in server["args"] if item != "-y"]
            source, *extra = arguments
            if name == "weather":
                server["command"] = "node"
                server["args"] = ["/agent-environment/src/agent_environment/run_node_mcp.cjs", f"@smithery/weather#{WEATHER_REVISION}", "bin/weather.js"]
            else:
                package, version = source.rsplit("@", 1)
                metadata = lock["node_modules/" + package]
                binaries = metadata.get("bin", {})
                if metadata["version"] != version or len(binaries) != 1:
                    raise ValueError(f"Missing unambiguous pinned entrypoint for {name}")
                server["command"] = "node"
                server["args"] = ["/agent-environment/src/agent_environment/run_node_mcp.cjs", source, next(iter(binaries.values())), *extra]
        python_bins = {
            "calculator": "mcp-server-calculator/bin/mcp-server-calculator",
            "ddg-search": "duckduckgo-mcp-server/bin/duckduckgo-mcp-server",
            "fetch": "mcp-server-fetch/bin/mcp-server-fetch",
            "wikipedia": "wikipedia-mcp/bin/wikipedia-mcp",
        }
        if name in python_bins:
            server["command"] = "/root/.local/share/uv/tools/" + python_bins[name]
            server["args"] = []
        elif name in {"osm-mcp-server", "twelvedata"}:
            package = "osm-mcp-server" if name == "osm-mcp-server" else "mcp-server-twelve-data"
            server["command"] = f"/root/.local/share/uv/tools/{package}/bin/python"
            original = server["args"]
            server["args"] = original[original.index("python") + 1:]
        server.setdefault("env", {}).update({
            "MCP_USAGE_LOG_DIR": "/app/data/mcp-usage", "MCP_USAGE_LOG_STDERR": "true",
        })
        server.update({"type": "stdio", "enabled": False})
        result[name] = server
    for name, server in result.items():
        if name in POLICY_PRESETS:
            server["rateLimit"] = dict(POLICY_PRESETS[name])
        if name == "open-library":
            server["command"] = "node"
            server["args"] = ["/app/scripts/run_open_library_limited.cjs"]
            server.setdefault("env", {})["OPEN_LIBRARY_MIN_INTERVAL_MS"] = "1000"
    return {"mcpServers": result}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--atlas", type=Path, default=Path.home() / "mcp-atlas")
    parser.add_argument("--servers", default=DEFAULT_SERVERS)
    parser.add_argument("--all-shared", action="store_true", help="Export all 26 shared services; keep task-isolated services in Atlas")
    args = parser.parse_args()
    names = [n.strip() for n in args.servers.split(",") if n.strip()]
    if args.all_shared:
        template = json.loads((args.atlas / "services/agent-environment/src/agent_environment/mcp_server_template.json").read_text())["mcpServers"]
        names = [name for name in template if name not in ISOLATED]
    print(json.dumps(export_servers(args.atlas, names), indent=2))


if __name__ == "__main__":
    main()
