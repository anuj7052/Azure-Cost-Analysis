#!/bin/bash
# Start the Azure Cost Analysis frontend
cd "$(dirname "$0")/frontend"

if [ ! -f ".env" ]; then
  echo "WARNING: .env file not found. Copying .env.example..."
  cp .env.example .env
  echo "Please edit frontend/.env and set VITE_AZURE_CLIENT_ID before running again."
  exit 1
fi

echo "Starting frontend on http://localhost:5173 ..."
npm run dev
