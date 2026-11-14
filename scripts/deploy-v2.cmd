@echo off
REM One-shot deploy wrapper: Task Scheduler runs this so the swap survives the
REM harness killing the process tree that started it.
cd /d D:\Code\pi-kanban-board
node scripts\deploy-v2.mjs --yes --delay=10 >> "%USERPROFILE%\.pi\kanban-deploy.log" 2>&1
