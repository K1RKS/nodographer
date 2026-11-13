#!/bin/bash
# Flush the meshinfo database.
# Stops the poller, drops and recreates the tables, and restarts it. The API
# keeps serving the last published snapshot until the next scan completes.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLLING_SCRIPT="$SCRIPT_DIR/meshinfoPoller.py"
VENV_PATH="$SCRIPT_DIR/venv"
SERVICE="meshinfo-poller.service"

if [ ! -f "$POLLING_SCRIPT" ]; then
    echo "Error: Could not find meshinfoPoller.py at $POLLING_SCRIPT"
    exit 1
fi

if [ ! -d "$VENV_PATH" ]; then
    echo "Error: Virtual environment not found at $VENV_PATH"
    exit 1
fi

cd "$SCRIPT_DIR" || exit 1

echo "Stopping $SERVICE..."
if ! systemctl stop "$SERVICE"; then
    echo "Warning: Could not stop $SERVICE (it may not be running)"
fi

sleep 2

echo "Flushing meshinfo database..."
"$VENV_PATH/bin/python3" "$POLLING_SCRIPT" --flush

sleep 2

echo "Starting $SERVICE..."
systemctl start "$SERVICE"
echo "The next scan publishes from the empty database. If it has far fewer nodes than"
echo "the current snapshot, [publish] minNodeRatio rejects it; set minNodeRatio = 0"
echo "in meshinfo.toml temporarily if you want the flushed data published immediately."
