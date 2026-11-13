#!/bin/bash
#
# Nodographer frontend installer
# ------------------------------
# Publishes frontend/ into the web root and points it at a meshinfo data
# source. No Python, database or poller is needed on a frontend-only host.
#
# Usage:
#   sudo frontend/INSTALL.sh                         # prompts for the mode
#   sudo frontend/INSTALL.sh --mode local            # meshinfo on this host
#   sudo frontend/INSTALL.sh --mode proxy  --meshinfo-url http://meshinfo-host:8090/api/v1/
#   sudo frontend/INSTALL.sh --mode direct --meshinfo-url https://meshinfo.example.org/api/v1/
#   sudo frontend/INSTALL.sh --mode legacy           # data rsynced into frontend/data/
#
# Options:
#   --data-dir DIR    meshinfo data dir for local mode (default: from
#                     meshinfo/meshinfo.toml, else /var/lib/meshinfo)
#   --web-root DIR    web server document root (default /var/www/html)
#   --web-name NAME   URL path / symlink name under the web root (default meshmap)
#   -y                don't prompt
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(dirname "$SCRIPT_DIR")"
FRONTEND_DIR="$INSTALL_DIR/frontend"
# shellcheck source=../lib/install-common.sh
source "$INSTALL_DIR/lib/install-common.sh"

MODE=""
MESHINFO_URL=""
DATA_DIR=""
WEB_ROOT="/var/www/html"
WEB_NAME="meshmap"
ASSUME_YES="${ASSUME_YES:-0}"

while [ $# -gt 0 ]; do
	case "$1" in
		--mode) MODE="$2"; shift 2 ;;
		--meshinfo-url) MESHINFO_URL="$2"; shift 2 ;;
		--data-dir) DATA_DIR="$2"; shift 2 ;;
		--web-root) WEB_ROOT="$2"; shift 2 ;;
		--web-name) WEB_NAME="$2"; shift 2 ;;
		-y|--yes) ASSUME_YES=1; shift ;;
		-h|--help) sed -n '2,24p' "$0"; exit 0 ;;
		*) print_error "Unknown argument: $1"; exit 1 ;;
	esac
done

require_root

CONFIG="$FRONTEND_DIR/config/nodographer.json"
WEB_LINK="$WEB_ROOT/$WEB_NAME"
WEB_PATH="/$WEB_NAME"

print_header "Nodographer frontend installation"

if [ -z "$MODE" ]; then
	if [ "$ASSUME_YES" = 1 ]; then
		MODE=local
	else
		echo "Where does this frontend get its mesh data?"
		echo "  1) local   meshinfo runs on this host"
		echo "  2) proxy   remote meshinfo API, proxied through this nginx (best for HTTPS sites)"
		echo "  3) direct  remote meshinfo API, fetched by the browser (needs CORS; TLS if this site is HTTPS)"
		echo "  4) legacy  JSON files rsynced into frontend/data/"
		read -r -p "Choose [1-4]: " choice
		case "$choice" in
			1) MODE=local ;; 2) MODE=proxy ;; 3) MODE=direct ;; 4) MODE=legacy ;;
			*) print_error "Invalid choice"; exit 1 ;;
		esac
	fi
fi

case "$MODE" in
	local|legacy) ;;
	proxy|direct)
		if [ -z "$MESHINFO_URL" ]; then
			if [ "$ASSUME_YES" = 1 ]; then
				print_error "--meshinfo-url is required for --mode $MODE"
				exit 1
			fi
			read -r -p "meshinfo API URL (e.g. http://meshinfo-host:8090/api/v1/): " MESHINFO_URL
		fi
		[[ "$MESHINFO_URL" == */ ]] || MESHINFO_URL="$MESHINFO_URL/"
		;;
	*) print_error "Unknown mode: $MODE (local, proxy, direct, legacy)"; exit 1 ;;
esac

if [ "$MODE" = local ] && [ -z "$DATA_DIR" ]; then
	if [ -f "$INSTALL_DIR/meshinfo/meshinfo.toml" ]; then
		DATA_DIR="$(python3 - "$INSTALL_DIR/meshinfo/meshinfo.toml" <<'PY'
import sys
try:
    import tomllib
except ImportError:
    import tomli as tomllib
with open(sys.argv[1], 'rb') as f:
    print(tomllib.load(f).get('publish', {}).get('dataDir', '/var/lib/meshinfo'))
PY
)"
	fi
	DATA_DIR="${DATA_DIR:-/var/lib/meshinfo}"
fi

case "$MODE" in
	local) BASE_URL="meshinfo/current/" ;;
	proxy) BASE_URL="meshinfo/" ;;
	direct) BASE_URL="$MESHINFO_URL" ;;
	legacy) BASE_URL="data/" ;;
esac

echo "Mode:       $MODE"
echo "Web path:   $WEB_LINK -> $FRONTEND_DIR"
echo "Data URL:   $BASE_URL"
[ "$MODE" = local ] && echo "Data dir:   $DATA_DIR"
[ "$MODE" = proxy ] && echo "Upstream:   $MESHINFO_URL"
echo ""
if ! confirm "Continue?"; then
	print_error "Cancelled"
	exit 1
fi

print_header "Web server"
if ! command -v nginx >/dev/null && ! command -v apache2 >/dev/null; then
	print_step "No web server found; installing nginx..."
	apt-get update -qq
	apt-get install -y nginx > /dev/null
fi
if [ -L "$WEB_LINK" ] || [ ! -e "$WEB_LINK" ]; then
	ln -sfn "$FRONTEND_DIR" "$WEB_LINK"
	print_success "$WEB_LINK -> $FRONTEND_DIR"
else
	print_error "$WEB_LINK exists and is not a symlink; remove it or use --web-name"
	exit 1
fi

print_header "Configuration"
if [ ! -f "$CONFIG" ]; then
	if [ -f "$INSTALL_DIR/settings.toml" ]; then
		print_step "Creating $CONFIG from legacy settings.toml"
		python3 "$INSTALL_DIR/meshinfo/tools/migrate_settings.py" --only frontend \
			--settings "$INSTALL_DIR/settings.toml" --frontend-out "$CONFIG" --base-url "$BASE_URL"
	else
		print_step "Creating $CONFIG from nodographer.example.json"
		cp "$FRONTEND_DIR/config/nodographer.example.json" "$CONFIG"
	fi
fi
python3 - "$CONFIG" "$BASE_URL" <<'PY'
import json, sys
path, base = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as f:
    cfg = json.load(f)
cfg.setdefault('meshinfo', {})['baseUrl'] = base
with open(path, 'w', encoding='utf-8') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write('\n')
PY
chmod 644 "$CONFIG"
print_success "meshinfo.baseUrl = $BASE_URL in $CONFIG"

SNIPPET=""
if [ "$MODE" != local ] && [ -L "$FRONTEND_DIR/meshinfo" ]; then
	rm -f "$FRONTEND_DIR/meshinfo"
fi
case "$MODE" in
	local)
		print_header "Local meshinfo data"
		ln -sfn "$DATA_DIR" "$FRONTEND_DIR/meshinfo"
		print_success "$FRONTEND_DIR/meshinfo -> $DATA_DIR"
		group="$(web_group)"
		if [ -n "$group" ] && [ -d "$DATA_DIR" ] && [ "$(stat -c %G "$DATA_DIR")" != "$group" ]; then
			print_error "$DATA_DIR is not group '$group'; the web server may not be able to read it"
			echo "  Fix: sudo chgrp $group $DATA_DIR && sudo chmod 2750 $DATA_DIR"
		fi
		if [ -d /etc/nginx/snippets ]; then
			SNIPPET=/etc/nginx/snippets/nodographer-local.conf
			render_template "$FRONTEND_DIR/deploy/nginx-local.conf" "$SNIPPET" "WEB_PATH=$WEB_PATH"
		fi
		;;
	proxy)
		print_header "nginx proxy"
		if [ -d /etc/nginx/snippets ]; then
			SNIPPET=/etc/nginx/snippets/nodographer-meshinfo.conf
			render_template "$FRONTEND_DIR/deploy/nginx-proxy.conf" "$SNIPPET" \
				"WEB_PATH=$WEB_PATH" "MESHINFO_URL=$MESHINFO_URL"
		else
			print_error "nginx snippets dir not found; proxy $WEB_PATH/meshinfo/ to $MESHINFO_URL in your web server manually"
		fi
		;;
	direct)
		print_step "The browser will fetch $MESHINFO_URL directly."
		echo "  meshinfo must allow this site's origin ([api] allowOrigins) and use HTTPS if this site does."
		;;
	legacy)
		print_step "Copy meshinfo output into $FRONTEND_DIR/data/, e.g.:"
		echo "  rsync -aL --delete-after --exclude tileservers.local.json --exclude .gitkeep \\"
		echo "      meshinfo-host:/var/lib/meshinfo/current/ $FRONTEND_DIR/data/"
		;;
esac

if [ -n "$SNIPPET" ]; then
	print_success "Installed $SNIPPET"
	if grep -rqs "include snippets/$(basename "$SNIPPET")" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/; then
		if nginx -t 2>/dev/null; then
			systemctl reload nginx
			print_success "nginx reloaded"
		else
			print_error "nginx -t failed; check your configuration"
		fi
	else
		echo ""
		echo "  Add this line inside your server { } block (e.g. /etc/nginx/sites-available/default),"
		echo "  then run: sudo nginx -t && sudo systemctl reload nginx"
		echo ""
		echo "      include snippets/$(basename "$SNIPPET");"
		echo ""
	fi
fi

print_header "Frontend ready"
echo "  Map:     http://$(hostname -f 2>/dev/null || hostname)$WEB_PATH/"
echo "  Config:  $CONFIG"
echo ""
