@echo off
rem Быстрый запуск прототипа «НЕФТЬ · Истории гостей»
cd /d "%~dp0"
python server.py --port 8000
pause
