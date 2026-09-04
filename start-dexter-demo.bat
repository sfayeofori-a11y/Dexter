@echo off
REM Double-click this to serve the standalone dexter-demo build (index.html,
REM project.html, css/, js/) over plain HTTP on localhost:4390 -- using
REM dexter-demo/server.js, the same zero-dependency static file server pattern
REM as start-dexter-site.bat, just rooted at the separate dexter-demo folder
REM instead of the repo root and on its own port.
REM
REM dexter-demo now lives outside this repo, at:
REM   C:\Users\tobia\Downloads\dexter-demo
REM (moved out of /demo so it's a fully independent, self-contained project.)
REM
REM Point a Cloudflare Tunnel public hostname at http://localhost:4390 to share
REM the demo the same way the real site is shared -- this is a separate route
REM from the main dashboard's :4090 (and the coordination server's :5057), so
REM all three can run side by side without colliding.
REM
REM NOTE: dexter-demo is fully static and serverless by design -- there is no
REM coordination-server equivalent for it and none is needed. State lives only
REM in the browser's localStorage and resets on every page load.
title Dexter demo (static site)
cd /d "C:\Users\tobia\Downloads\dexter-demo"
echo Starting Dexter demo on http://localhost:4390 ...
echo Point your Cloudflare Tunnel at this address. Leave this window open
echo while you're testing. Close it, or press Ctrl+C, to stop.
echo.
node server.js
echo.
echo Server stopped (or failed to start -- see any error above).
pause
