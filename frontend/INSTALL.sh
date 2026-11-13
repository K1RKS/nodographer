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
#   --from-legacy-settings
#                     build a missing nodographer.json from the legacy
#                     settings.toml instead of nodographer.example.json
#                     (update.sh uses this when migrating an old install)
#   --no-web-server   don't install nginx, symlink the web root or write nginx
#                     snippets; serve frontend/ with your own web server
#   -y                don't prompt
#
# Environment overrides:
#   CONFIG_OWNER      root   (owner of a newly created nodographer.json)
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
FROM_LEGACY=0
WEB_SERVER=1
ASSUME_YES="${ASSUME_YES:-0}"

while [ $# -gt 0 ]; do
	case "$1" in
		--mode) MODE="$2"; shift 2 ;;
		--meshinfo-url) MESHINFO_URL="$2"; shift 2 ;;
		--data-dir) DATA_DIR="$2"; shift 2 ;;
		--web-root) WEB_ROOT="$2"; shift 2 ;;
		--web-name) WEB_NAME="$2"; shift 2 ;;
		--from-legacy-settings) FROM_LEGACY=1; shift ;;
		--no-web-server) WEB_SERVER=0; shift ;;
		-y|--yes) ASSUME_YES=1; shift ;;
		-h|--help) sed -n '2,33p' "$0"; exit 0 ;;
		*) print_error "Unknown argument: $1"; exit 1 ;;
	esac
done

require_root

if ! command -v python3 >/dev/null; then
	print_step "Installing python3 (used by this installer)..."
	apt-get update -qq
	apt-get install -y python3 > /dev/null
fi
# The meshinfo venv has tomli, which Python < 3.11 needs to read TOML
PYTHON=python3
if [ -x "$INSTALL_DIR/meshinfo/venv/bin/python3" ]; then
	PYTHON="$INSTALL_DIR/meshinfo/venv/bin/python3"
fi

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
		DATA_DIR="$("$PYTHON" - "$INSTALL_DIR/meshinfo/meshinfo.toml" <<'PY'
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

if [ "$WEB_SERVER" = 1 ]; then
	print_header "Web server"
	if ! command -v nginx >/dev/null && ! command -v apache2 >/dev/null; then
		print_step "No web server found; installing nginx..."
		apt-get update -qq
		apt-get install -y nginx > /dev/null
		systemctl enable --now nginx >/dev/null 2>&1 || true
	fi
	if [ -L "$WEB_LINK" ] || [ ! -e "$WEB_LINK" ]; then
		mkdir -p "$WEB_ROOT"
		ln -sfn "$FRONTEND_DIR" "$WEB_LINK"
		print_success "$WEB_LINK -> $FRONTEND_DIR"
	else
		print_error "$WEB_LINK exists and is not a symlink; remove it or use --web-name"
		exit 1
	fi
fi

print_header "Configuration"
if [ ! -f "$CONFIG" ]; then
	if [ "$FROM_LEGACY" = 1 ] && [ -f "$INSTALL_DIR/settings.toml" ]; then
		print_step "Creating $CONFIG from legacy settings.toml"
		"$PYTHON" "$INSTALL_DIR/meshinfo/tools/migrate_settings.py" --only frontend \
			--settings "$INSTALL_DIR/settings.toml" --frontend-out "$CONFIG" --base-url "$BASE_URL"
	else
		print_step "Creating $CONFIG from nodographer.example.json"
		cp "$FRONTEND_DIR/config/nodographer.example.json" "$CONFIG"
	fi
	chown "${CONFIG_OWNER:-root}" "$CONFIG"
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
NGINX_CHANGED=0
if [ "$MODE" != local ] && [ -L "$FRONTEND_DIR/meshinfo" ]; then
	rm -f "$FRONTEND_DIR/meshinfo"
fi
if [ "$WEB_SERVER" = 0 ]; then
	SNIPPETS_DIR=""
else
	SNIPPETS_DIR=/etc/nginx/snippets
fi

# The local and proxy snippets both define $WEB_PATH/meshinfo/, so the one the
# new mode doesn't use has to go (a wildcard include would load both)
case "$MODE" in
	local) MODE_SNIPPET=nodographer-local.conf ;;
	proxy) MODE_SNIPPET=nodographer-meshinfo.conf ;;
	*) MODE_SNIPPET="" ;;
esac
if [ -n "$SNIPPETS_DIR" ]; then
	for stale in nodographer-local.conf nodographer-meshinfo.conf; do
		[ "$stale" = "$MODE_SNIPPET" ] && continue
		[ -e "$SNIPPETS_DIR/$stale" ] || continue
		if grep -Rqs "include snippets/$stale" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/; then
			print_error "$SNIPPETS_DIR/$stale is not used in $MODE mode; remove its include line from your nginx config, then delete it"
		else
			rm -f "$SNIPPETS_DIR/$stale"
			NGINX_CHANGED=1
			print_step "Removed $SNIPPETS_DIR/$stale (not used in $MODE mode)"
		fi
	done
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
		if [ -n "$SNIPPETS_DIR" ] && [ -d "$SNIPPETS_DIR" ]; then
			SNIPPET="$SNIPPETS_DIR/$MODE_SNIPPET"
			render_template "$FRONTEND_DIR/deploy/nginx-local.conf" "$SNIPPET" "WEB_PATH=$WEB_PATH"
		fi
		;;
	proxy)
		print_header "nginx proxy"
		if [ -n "$SNIPPETS_DIR" ] && [ -d "$SNIPPETS_DIR" ]; then
			SNIPPET="$SNIPPETS_DIR/$MODE_SNIPPET"
			render_template "$FRONTEND_DIR/deploy/nginx-proxy.conf" "$SNIPPET" \
				"WEB_PATH=$WEB_PATH" "MESHINFO_URL=$MESHINFO_URL"
		elif [ "$WEB_SERVER" = 1 ]; then
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
	# Included by name, or by the wildcard in the site lxc-install.sh writes
	if grep -RqsE "include snippets/($(basename "$SNIPPET")|nodographer-\*\.conf)" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/; then
		NGINX_CHANGED=1
	else
		echo ""
		echo "  Add this line inside your server { } block (e.g. /etc/nginx/sites-available/default),"
		echo "  then run: sudo nginx -t && sudo systemctl reload nginx"
		echo ""
		echo "      include snippets/$(basename "$SNIPPET");"
		echo ""
	fi
fi
if [ "$NGINX_CHANGED" = 1 ] && command -v nginx >/dev/null; then
	if nginx -t 2>/dev/null; then
		systemctl reload nginx
		print_success "nginx reloaded"
	else
		print_error "nginx -t failed; check your configuration"
	fi
fi

print_header "Frontend ready"
if [ "$WEB_SERVER" = 1 ]; then
	echo "  Map:     http://$(hostname -f 2>/dev/null || hostname)$WEB_PATH/"
else
	echo "  Serve $FRONTEND_DIR with your web server (for example at $WEB_PATH/)."
	[ "$MODE" = local ] && echo "  It must follow the symlink $FRONTEND_DIR/meshinfo -> $DATA_DIR."
	[ "$MODE" = proxy ] && echo "  Proxy $WEB_PATH/meshinfo/ to $MESHINFO_URL (see frontend/deploy/nginx-proxy.conf)."
fi
echo "  Config:  $CONFIG"
echo ""
