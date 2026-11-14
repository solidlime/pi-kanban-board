@echo off
REM One-shot restart wrapper: Task Scheduler runs this so the restart survives the harness
REM killing the process tree that started it.
cd /d D:\Code\pi-kanban-board
node scripts\restart-pi-web.mjs --port=30141 >> "%USERPROFILE%\.pi\kanban-deploy.log" 2>&1
