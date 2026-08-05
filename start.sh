#!/bin/bash
# Azure Cost Analysis — Start Script
# Usage: bash start.sh

BASE="$(cd "$(dirname "$0")" && pwd)"

echo "Starting Azure Cost Analysis..."

# Kill existing servers
kill $(lsof -ti:8000 -ti:5173) 2>/dev/null
sleep 1

# Start backend
cd "$BASE/backend"
source .venv/bin/activate
uvicorn main:app --reload --port 8000 &
BACKEND_PID=$!
echo "Backend started (PID $BACKEND_PID) → http://localhost:8000"

# Start frontend
sleep 2
cd "$BASE/frontend"
npm run dev &
FRONTEND_PID=$!
echo "Frontend started (PID $FRONTEND_PID) → http://localhost:5173"

echo ""
echo "✓ Both servers running!"
echo "  Open: http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop both servers"

# Wait and stop both on Ctrl+C
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; echo 'Servers stopped.'" EXIT
wait
