@echo off
rem Launch the hot-reload dev server (electron-vite) from a shortcut.
rem The console is meant to be MINIMIZED by the shortcut: it hosts the vite
rem dev server + file watchers, and closing it stops the dev server. The
rem Electron window itself opens normally.
cd /d "%~dp0"
title Cascade dev (hot reload)
if not exist "node_modules" (
  echo node_modules is missing - run "npm install" in %CD% first.
  pause
  exit /b 1
)
call npm run dev
