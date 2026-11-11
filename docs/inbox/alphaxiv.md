TODO: Add this as an example of plugin/mcp.
https://www.alphaxiv.org/docs/mcp
<!--  -->
MCP Server
The alphaXiv Model Context Protocol (MCP) server gives AI applications, agents, and workflows programmatic access to our research corpus. Search and read papers, analyze PDFs, explore paper codebases, find the researchers behind the work, and manage your library — all through native MCP tools.

Getting started
Endpoint
https://api.alphaxiv.org/mcp/v1
Transport
Streamable HTTP (POST for requests, GET for server→client SSE stream, DELETE to terminate)
Authentication
By default the server advertises OAuth 2.1: your MCP client opens a browser sign-in on first use and refreshes tokens on its own. No configuration needed.

For non-interactive use (scripts, CI, headless agents), create an API key under Settings > API Keys and send it as an Authorization: Bearer <key> header instead. A request carrying a key skips the OAuth flow entirely, and deleting the key revokes access immediately.
Protocol
Model Context Protocol (MCP) v1.0.0
Supported clients
Native MCP clients only — Claude Code, Claude Desktop, Cursor, VS Code, Zed, and CLI bridges like mcp-remote.

Browser-hosted MCP integrations (e.g. adding this server directly inside claude.ai or chatgpt.com) are not supported, because CORS is locked down to first-party origins.
To use this server from a browser-based assistant, run a local bridge such as npx mcp-remote https://api.alphaxiv.org/mcp/v1 and point the assistant at the bridge.
<!--  -->