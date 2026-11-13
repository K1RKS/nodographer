#!/bin/bash
#
# Nodographer Installation Script
# -------------------------------
# Nodographer has two parts that can run on the same VM or on different VMs:
#
#   meshinfo   scanner + node database + read-only data API  (meshinfo/INSTALL.sh)
#   frontend   static Leaflet map + node report               (frontend/INSTALL.sh)
#
# Usage:
#   sudo ./INSTALL.sh               # asks: both, meshinfo only, or frontend only
#   sudo ./INSTALL.sh --meshinfo    # scanner + API only
#   sudo ./INSTALL.sh --frontend [frontend/INSTALL.sh options]
#                                   # map only, e.g. --mode proxy --meshinfo-url http://host:8090/api/v1/
#   sudo ./INSTALL.sh -y            # don't prompt; installs both unless a flag picks one
#

echo "Nodographer -- A Babel-aware AREDN Mesh Network Map"
echo "Copyright (C) 2025 John M. Simpson AI7BQ"
echo ""
echo "This program is free software: you can redistribute it and/or modify"
echo "it under the terms of the GNU General Public License as published by"
echo "the Free Software Foundation, either version 3 of the License, or"
echo "(at your option) any later version."
echo ""
echo "This program is distributed in the hope that it will be useful,"
echo "but WITHOUT ANY WARRANTY; without even the implied warranty of"
echo "MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the"
echo "GNU General Public License for more details."
echo ""
echo "You should have received a copy of the GNU General Public License"
echo "along with this program.  If not, see https://www.gnu.org/licenses."
echo ""

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/install-common.sh
source "$SCRIPT_DIR/lib/install-common.sh"

WANT_MESHINFO=0
WANT_FRONTEND=0
PASS=()
for arg in "$@"; do
	case "$arg" in
		--meshinfo) WANT_MESHINFO=1 ;;
		--frontend) WANT_FRONTEND=1 ;;
		-y|--yes) export ASSUME_YES=1 ;;
		-h|--help) sed -n '2,17p' "$0"; exit 0 ;;
		*) PASS+=("$arg") ;;
	esac
done
if [ "$WANT_MESHINFO" = 0 ] && [ "$WANT_FRONTEND" = 0 ]; then
	CHOICE=1
	if [ "${ASSUME_YES:-0}" != 1 ] && [ -t 0 ]; then
		echo "Which parts should this host run?"
		echo "  1) both      scanner + data API, and the map reading it locally"
		echo "  2) meshinfo  scanner + data API only (a map elsewhere reads it)"
		echo "  3) frontend  the map only (reads a meshinfo API on another host)"
		read -r -p "Choose 1-3 [1]: " CHOICE
		CHOICE="${CHOICE:-1}"
	fi
	case "$CHOICE" in
		1|both) WANT_MESHINFO=1; WANT_FRONTEND=1 ;;
		2|meshinfo) WANT_MESHINFO=1 ;;
		3|frontend) WANT_FRONTEND=1 ;;
		*) print_error "Invalid choice: $CHOICE"; exit 1 ;;
	esac
fi
PARTS=()
[ "$WANT_MESHINFO" = 1 ] && PARTS+=(meshinfo)
[ "$WANT_FRONTEND" = 1 ] && PARTS+=(frontend)
echo "Installing: ${PARTS[*]}"
echo ""

require_root

# meshinfo/INSTALL.sh retires the legacy unit, so check for it first
FRONTEND_ARGS=()
if [ -e /etc/systemd/system/meshmapPoller.service ]; then
	FRONTEND_ARGS+=(--from-legacy-settings)
fi

if [ "$WANT_MESHINFO" = 1 ]; then
	"$SCRIPT_DIR/meshinfo/INSTALL.sh"
fi

if [ "$WANT_FRONTEND" = 1 ]; then
	if [ "$WANT_MESHINFO" = 1 ] && [ ${#PASS[@]} -eq 0 ]; then
		FRONTEND_ARGS+=(--mode local)
	fi
	"$SCRIPT_DIR/frontend/INSTALL.sh" "${FRONTEND_ARGS[@]}" "${PASS[@]}"
fi

print_success "Installation completed successfully!"
