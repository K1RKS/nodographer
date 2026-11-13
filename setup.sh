#!/bin/bash
#
# Nodographer setup
# -----------------
# Configures whatever is installed on this host (meshinfo and/or the map):
# topology node, scan timing, map title and center, tile servers, and so on.
# Current values are offered as defaults; run it again any time.
#
# Run as the user that owns the config files (lxc-install.sh creates it and
# links this script as ~/nodographer-setup), or with sudo.
#
# Usage: ./setup.sh [--meshinfo | --frontend]
#

DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
PYTHON=python3
if [ -x "$DIR/meshinfo/venv/bin/python3" ]; then
	PYTHON="$DIR/meshinfo/venv/bin/python3"
fi
exec "$PYTHON" "$DIR/lib/nodographer_setup.py" "$@"
