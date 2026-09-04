@echo off
REM Double-click this to start dexter-claude-mcp-server (claude-mcp-server/index.js)
REM without opening a terminal and typing the command yourself. See
REM claude-mcp-server/README.md for what this server does, how to configure
REM its .env (ISSUER_URL/AUTH_SHARED_SECRET/PORT), and how to tunnel it.
REM
REM This is a THIRD, separate process from the other two launchers in this
REM folder — it does not start alongside start-dexter-server.bat (the
REM coordination server, server/index.js, port 5057) or start-dexter-site.bat
REM (the static dashboard, port 4090), and neither of those starts it either.
REM Leave all three running side by side.
REM
REM Also requires CLAUDE_MCP_PUBLIC_URL to be set in server\.env (a
REM DIFFERENT .env file, for the coordination server) to the same value as
REM this server's own ISSUER_URL — that's what lets each project's Settings
REM panel show the right connector URL. If Settings still shows "Not set up
REM yet" after this window says it's listening, check that value.
title Dexter Claude MCP server
cd /d "%~dp0claude-mcp-server"
echo Starting dexter-claude-mcp-server (claude-mcp-server/index.js)...
echo Leave this window open while you want Claude/Cowork connectors to work.
echo Close it, or press Ctrl+C, to stop the server.
echo.
node index.js
echo.
echo Server stopped (or failed to start — see any error above).
pause
