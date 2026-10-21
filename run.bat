@echo off
cd /d "%~dp0"
if not exist .venv (
  echo Setting up Python environment...
  python -m venv .venv
  .venv\Scripts\python -m pip install -r requirements.txt
)
start "" http://localhost:5180
.venv\Scripts\python server\app.py
