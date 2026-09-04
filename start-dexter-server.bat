@echo off
REM Double-click this to start the Dexter <-> Hermes coordination server
REM (server/index.js) without opening a terminal and typing the command
REM yourself. See server/README.md for what this server does and why it
REM needs to be running for live chat/intake against Hermes.
REM
REM The Hermes gateway itself is assumed to already be running persistently
REM (per Tobias, 2026-07-04) — this only starts Dexter's own local
REM coordination server, not Hermes.
title Dexter coordination server
cd /d "%~dp0server"
echo Starting Dexter coordination server (server/index.js)...
echo Leave this window open while you use the dashboard. Close it, or press
echo Ctrl+C, to stop the server.
echo.
node index.js
echo.
echo Server stopped (or failed to start — see any error above).
pause
