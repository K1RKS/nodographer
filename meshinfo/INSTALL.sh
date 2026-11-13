#!/bin/bash
#
# meshinfo installer
# ------------------
# Installs the Nodographer scanner (meshinfo-poller.service) and its read-only
# data API (meshinfo-api.service) from this git checkout. Safe to re-run.
#
# Usage:
#   sudo meshinfo/INSTALL.sh            # fresh install (packages, DB, venv, services)
#   sudo meshinfo/INSTALL.sh --update   # refresh venv + units, migrate legacy installs
#   sudo meshinfo/INSTALL.sh -y         # don't prompt
#   sudo meshinfo/INSTALL.sh --no-start # install but don't start services
#
# Environment overrides:
#   DATA_DIR      /var/lib/meshinfo   (only used when meshinfo.toml is created)
#   SERVICE_USER  meshmap
#   DB_NAME       node_map
#   DB_USER       mesh-map
#   DB_PASS       password
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(dirname "$SCRIPT_DIR")"
MESHINFO_DIR="$INSTALL_DIR/meshinfo"
# shellcheck source=../lib/install-common.sh
source "$INSTALL_DIR/lib/install-common.sh"

UPDATE=0
START=1
ASSUME_YES="${ASSUME_YES:-0}"
for arg in "$@"; do
	case "$arg" in
		--update) UPDATE=1 ;;
		--no-start) START=0 ;;
		-y|--yes) ASSUME_YES=1 ;;
		-h|--help) sed -n '2,22p' "$0"; exit 0 ;;
		*) print_error "Unknown argument: $arg"; exit 1 ;;
	esac
done

require_root

SERVICE_USER="${SERVICE_USER:-meshmap}"
DB_NAME="${DB_NAME:-node_map}"
DB_USER="${DB_USER:-mesh-map}"
DB_PASS="${DB_PASS:-password}"
VENV="$MESHINFO_DIR/venv"
CONFIG="$MESHINFO_DIR/meshinfo.toml"
LEGACY_SETTINGS="$INSTALL_DIR/settings.toml"
LEGACY_UNIT="/etc/systemd/system/meshmapPoller.service"
UNITS=(meshinfo-poller.service meshinfo-api.service)
MIGRATED=0

print_header "meshinfo $([ "$UPDATE" = 1 ] && echo update || echo installation)"
echo "Checkout:      $INSTALL_DIR"
echo "Service user:  $SERVICE_USER"
echo ""

if [ "$UPDATE" = 0 ] && ! confirm "Continue?"; then
	print_error "Cancelled"
	exit 1
fi

install_packages() {
	print_header "Packages"
	print_step "Installing python3, python3-venv, python3-pip, mariadb-server, traceroute..."
	apt-get update -qq
	# traceroute: hop-count probing ([hops] enableHopCount)
	apt-get install -y python3 python3-venv python3-pip mariadb-server traceroute > /dev/null
	print_success "Packages installed"
}

ensure_user() {
	if ! id "$SERVICE_USER" &>/dev/null; then
		print_step "Creating system user '$SERVICE_USER'..."
		useradd -r -s /bin/false -d "$MESHINFO_DIR" -c "meshinfo poller" "$SERVICE_USER"
	fi
	if [ -d "$INSTALL_DIR/.cache" ]; then
		chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/.cache"
	fi
}

retire_legacy_service() {
	if [ -e "$LEGACY_UNIT" ] || systemctl list-unit-files meshmapPoller.service 2>/dev/null | grep -q meshmapPoller; then
		print_step "Retiring legacy meshmapPoller.service..."
		systemctl stop meshmapPoller.service 2>/dev/null || true
		systemctl disable meshmapPoller.service 2>/dev/null || true
		rm -f "$LEGACY_UNIT"
		systemctl daemon-reload
		MIGRATED=1
		print_success "meshmapPoller.service removed (replaced by meshinfo-poller.service)"
	fi
	# Untracked leftovers of the old backend/ directory
	if [ -d "$INSTALL_DIR/backend" ]; then
		rm -rf "$INSTALL_DIR/backend/venv" "$INSTALL_DIR/backend/__pycache__"
		rmdir "$INSTALL_DIR/backend" 2>/dev/null || print_step "Left $INSTALL_DIR/backend in place (contains other files)"
	fi
}

ensure_venv() {
	print_header "Python virtual environment"
	if [ ! -x "$VENV/bin/python3" ]; then
		print_step "Creating $VENV..."
		python3 -m venv "$VENV"
	fi
	print_step "Installing requirements..."
	"$VENV/bin/pip" install --upgrade pip -q
	"$VENV/bin/pip" install -r "$MESHINFO_DIR/requirements.txt" -q
	print_success "Python dependencies installed"
}

ensure_database() {
	print_header "Database"
	systemctl enable --now mariadb >/dev/null 2>&1 || systemctl enable --now mysql >/dev/null 2>&1 || true
	mysql -u root <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL
	print_success "Database '$DB_NAME' ready (tables are created on first run)"
}

ensure_config() {
	print_header "Configuration"
	if [ -f "$CONFIG" ]; then
		print_step "Keeping existing $CONFIG"
	elif [ -f "$LEGACY_SETTINGS" ] && { [ "$UPDATE" = 1 ] || [ "$MIGRATED" = 1 ]; }; then
		# frontend/INSTALL.sh migrates the map settings into frontend/config/nodographer.json
		print_step "Migrating $LEGACY_SETTINGS -> meshinfo.toml"
		"$VENV/bin/python3" "$MESHINFO_DIR/tools/migrate_settings.py" --only meshinfo \
			--settings "$LEGACY_SETTINGS" --data-dir "${DATA_DIR:-/var/lib/meshinfo}"
		MIGRATED=1
	else
		print_step "Creating $CONFIG from meshinfo.example.toml"
		cp "$MESHINFO_DIR/meshinfo.example.toml" "$CONFIG"
		sed -i "s|^dataDir = .*|dataDir = \"${DATA_DIR:-/var/lib/meshinfo}\"|" "$CONFIG"
		sed -i "s|^password = .*|password = \"$DB_PASS\"|; s|^user = .*|user = \"$DB_USER\"|; s|^database = .*|database = \"$DB_NAME\"|" "$CONFIG"
		print_step "Edit $CONFIG to set nodelistNode and other options"
	fi
	chown "root:$SERVICE_USER" "$CONFIG"
	chmod 640 "$CONFIG"
	DATA_DIR="$("$VENV/bin/python3" -c "import sys; sys.path.insert(0, '$MESHINFO_DIR'); from meshinfo_config import ConfigManager; print(ConfigManager('$CONFIG').data_dir)")"
	print_success "Config: $CONFIG (dataDir = $DATA_DIR)"
}

ensure_data_dir() {
	local group
	group="$(web_group)"
	group="${group:-$SERVICE_USER}"
	print_step "Preparing data directory $DATA_DIR (owner $SERVICE_USER, group $group)"
	install -d -o "$SERVICE_USER" -g "$group" -m 2750 "$DATA_DIR"
	chown "$SERVICE_USER:$group" "$DATA_DIR"
	chmod 2750 "$DATA_DIR"
}

install_units() {
	print_header "systemd units"
	local unit
	for unit in "${UNITS[@]}"; do
		render_template "$MESHINFO_DIR/$unit" "/etc/systemd/system/$unit" \
			"INSTALL_DIR=$INSTALL_DIR" "DATA_DIR=$DATA_DIR" "SERVICE_USER=$SERVICE_USER"
		print_step "Installed /etc/systemd/system/$unit"
	done
	systemctl daemon-reload
	systemctl enable "${UNITS[@]}" >/dev/null 2>&1
	print_success "Units enabled"
}

publish_from_database() {
	print_step "Publishing a snapshot from the existing database so the API has data now..."
	if (cd "$MESHINFO_DIR" && sudo -u "$SERVICE_USER" "$VENV/bin/python3" meshinfoPoller.py --publish-only >/dev/null); then
		print_success "Snapshot published: $(readlink "$DATA_DIR/current" || echo none)"
	else
		print_error "Could not publish from the database; the first poll cycle will publish instead"
	fi
}

start_services() {
	print_header "Starting services"
	systemctl restart "${UNITS[@]}"
	sleep 2
	local unit
	for unit in "${UNITS[@]}"; do
		if systemctl is-active --quiet "$unit"; then
			print_success "$unit is running"
		else
			print_error "$unit failed to start: journalctl -u $unit"
		fi
	done
}

[ "$UPDATE" = 0 ] && install_packages
ensure_user
retire_legacy_service
ensure_venv
[ "$UPDATE" = 0 ] && ensure_database
ensure_config
ensure_data_dir
install_units
if [ "$UPDATE" = 1 ] || [ "$MIGRATED" = 1 ]; then
	systemctl stop "${UNITS[@]}" 2>/dev/null || true
	publish_from_database
fi
if [ "$START" = 1 ]; then
	start_services
fi

API_PORT="$("$VENV/bin/python3" -c "import sys; sys.path.insert(0, '$MESHINFO_DIR'); from meshinfo_config import ConfigManager; print(ConfigManager('$CONFIG').getint('api', 'port', 8090))")"
print_header "meshinfo ready"
echo "  Config:     $CONFIG"
echo "  Data:       $DATA_DIR/current  (status: $DATA_DIR/status.json)"
echo "  API:        http://$(hostname -f 2>/dev/null || hostname):$API_PORT/api/v1/status.json"
echo "  Logs:       journalctl -fu meshinfo-poller.service"
echo "              journalctl -fu meshinfo-api.service"
echo ""
