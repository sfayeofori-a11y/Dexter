@echo off
REM Double-click this to serve the Dexter dashboard itself (index.html,
REM project.html, assets/) over plain HTTP on localhost:4090 — using
REM server.js, the zero-dependency static file server already in this repo.
REM
REM Why you'd want this instead of just double-clicking index.html: opening
REM the dashboard as a file:// page works fine on this PC, but a Cloudflare
REM Tunnel (or any tunnel) can only forward an actual HTTP port, not a local
REM file path. Point cloudflared at http://localhost:4090 and it'll tunnel
REM the whole dashboard out to your custom subdomain for phone testing.
REM
REM NOTE: this only serves the static dashboard. The separate coordination
REM server (start-dexter-server.bat, server/index.js on port 5057) is what
REM live chat/intake/sync talk to. For that to work from your phone too,
REM point a SECOND Cloudflare Tunnel public hostname at localhost:5057 —
REM named "<your-site-subdomain>-api" (e.g. site is dexter.ttsimin.com, the
REM API hostname is dexter-api.ttsimin.com) — assets/js/project-data.js's
REM HERMES_SERVER resolves to that pattern automatically once it's not on
REM localhost. Without that second hostname, the dashboard still loads fine
REM on a phone, it just silently falls back to local-only (no sync, no live
REM chat/intake).
title Dexter dashboard (static site)
cd /d "%~dp0"
echo Starting Dexter dashboard on http://localhost:4090 ...
echo Point your Cloudflare Tunnel at this address. Leave this window open
echo while you're testing. Close it, or press Ctrl+C, to stop.
echo.
node server.js
echo.
echo Server stopped (or failed to start — see any error above).
pause
