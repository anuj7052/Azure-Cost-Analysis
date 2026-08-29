#!/bin/bash
# Start the Cloudledger backend
cd "$(dirname "$0")/backend"

if [ ! -d ".venv" ]; then
  echo "Creating virtual environment with Python 3.13..."
  python3.13 -m venv .venv
  source .venv/bin/activate
  pip install -r requirements.txt
else
  source .venv/bin/activate
fi

if [ ! -f ".env" ]; then
  echo "WARNING: .env file not found. Copying .env.example..."
  cp .env.example .env
  echo "Please edit backend/.env and set AZURE_CLIENT_ID before running again."
  exit 1
fi

echo "Starting backend on http://localhost:8000 ..."
uvicorn main:app --reload --port 8000
