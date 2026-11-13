#!/bin/bash
#
# Nodographer installer for a clean Debian 13 (trixie) Proxmox container or VM
# ---------------------------------------------------------------------------
# Run as root inside the container or VM:
#
#   apt update && apt install -y curl
#   curl -fsSLO https://raw.githubusercontent.com/K1RKS/nodographer/main/lxc-install.sh
#   bash lxc-install.sh
#
# It asks which parts to install (both, meshinfo only, or the map only),
# creates the user that runs the services and owns the configuration,
# clones the repository, optionally installs and configures nginx, and runs
# the component installers. Afterwards, log in as that user and run
# ~/nodographer-setup to set the topology node, map center, tile servers...
#
# Every question can be answered in advance with an environment variable
# (ASSUME_YES=1 takes the defaults for the rest):
#   COMPONENTS      both | meshinfo | frontend
#   SERVICE_USER    meshmap
#   WITH_NGINX      yes | no
#   FRONTEND_MODE   proxy | direct | legacy   (frontend-only installs)
#   MESHINFO_URL    http://meshinfo-host:8090/api/v1/
#   SET_PASSWORD    yes | no
#   REPO_URL        https://github.com/K1RKS/nodographer.git
#   BRANCH          main
#   INSTALL_DIR     /srv/meshmap
#

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

REPO_URL="${REPO_URL:-https://github.com/K1RKS/nodographer.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/srv/meshmap}"
ASSUME_YES="${ASSUME_YES:-0}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
say() { echo -e "${YELLOW}➜${NC} $1"; }
ok() { echo -e "${GREEN}✓${NC} $1"; }
die() { echo -e "${RED}✗${NC} $1" >&2; exit 1; }
section() { echo -e "\n${GREEN}== $1 ==${NC}\n"; }

# Prompts read the terminal even when this script arrives on a pipe
TTY=/dev/stdin
if { : </dev/tty; } 2>/dev/null; then
	TTY=/dev/tty
fi

# ask VAR "Prompt" [default]: keeps a value preset in the environment
ask() {
	local __var="$1" prompt="$2" def="${3:-}" reply=""
	if [ -n "${!__var:-}" ]; then
		return
	fi
	if [ "$ASSUME_YES" = 1 ]; then
		printf -v "$__var" '%s' "$def"
		return
	fi
	read -r -p "$prompt${def:+ [$def]}: " reply <"$TTY" || true
	printf -v "$__var" '%s' "${reply:-$def}"
}

# ask_yn VAR "Prompt" yes|no: sets VAR to yes or no
ask_yn() {
	local __var="$1" prompt="$2" def="$3" hint
	[ "$def" = yes ] && hint=Y/n || hint=y/N
	while true; do
		ask "$__var" "$prompt ($hint)" ""
		case "${!__var,,}" in
			"") printf -v "$__var" '%s' "$def"; return ;;
			y|yes) printf -v "$__var" yes; return ;;
			n|no) printf -v "$__var" no; return ;;
		esac
		echo "  Answer y or n."
		printf -v "$__var" '%s' ""
	done
}

[ "$EUID" -eq 0 ] || die "Run this as root inside the container."

section "Nodographer container install"
# shellcheck disable=SC1091
. /etc/os-release
if [ "${VERSION_CODENAME:-}" != trixie ]; then
	say "This script targets Debian 13 (trixie); this is ${PRETTY_NAME:-unknown}."
	ask_yn CONTINUE_ANYWAY "Continue anyway?" no
	[ "$CONTINUE_ANYWAY" = yes ] || exit 1
fi
VIRT="$(systemd-detect-virt -c 2>/dev/null || true)"

echo "Which parts should this container run?"
echo "  1) both      scanner + data API, and the map reading it locally"
echo "  2) meshinfo  scanner + data API only (a map elsewhere reads it)"
echo "  3) frontend  the map only (reads a meshinfo API on another host)"
if [ -z "${COMPONENTS:-}" ]; then
	ask CHOICE "Choose 1-3" 1
	case "$CHOICE" in
		1|both) COMPONENTS=both ;;
		2|meshinfo) COMPONENTS=meshinfo ;;
		3|frontend) COMPONENTS=frontend ;;
		*) die "Invalid choice: $CHOICE" ;;
	esac
fi
case "$COMPONENTS" in
	both|meshinfo|frontend) ;;
	*) die "COMPONENTS must be both, meshinfo or frontend" ;;
esac
WANT_MESHINFO=no
WANT_FRONTEND=no
[ "$COMPONENTS" != frontend ] && WANT_MESHINFO=yes
[ "$COMPONENTS" != meshinfo ] && WANT_FRONTEND=yes

echo ""
echo "One user runs the services and owns the configuration; you run the setup"
echo "script as this user after the install."
ask SERVICE_USER "User name" meshmap
[[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "Invalid user name: $SERVICE_USER"
ask_yn SET_PASSWORD "Set a password for $SERVICE_USER (for SSH login and sudo)?" no

echo ""
if [ "$WANT_FRONTEND" = yes ]; then
	ask_yn WITH_NGINX "Install and configure nginx to serve the map?" yes
else
	ask_yn WITH_NGINX "Install nginx to also publish the API on port 80 (/api/v1/)?" no
fi

if [ "$COMPONENTS" = frontend ]; then
	echo ""
	echo "Where does the map get its data?"
	if [ "$WITH_NGINX" = yes ]; then
		echo "  1) proxy   this nginx relays a remote meshinfo API (no CORS, works behind HTTPS)"
	fi
	echo "  2) direct  the browser fetches the remote meshinfo API itself"
	echo "  3) legacy  JSON files copied into frontend/data/ by rsync"
	if [ -z "${FRONTEND_MODE:-}" ]; then
		if [ "$WITH_NGINX" = yes ]; then
			ask CHOICE2 "Choose 1-3" 1
		else
			ask CHOICE2 "Choose 2-3" 2
		fi
		case "$CHOICE2" in
			1|proxy) FRONTEND_MODE=proxy ;;
			2|direct) FRONTEND_MODE=direct ;;
			3|legacy) FRONTEND_MODE=legacy ;;
			*) die "Invalid choice: $CHOICE2" ;;
		esac
	fi
	case "$FRONTEND_MODE" in
		proxy) [ "$WITH_NGINX" = yes ] || die "proxy mode needs nginx" ;;
		direct|legacy) ;;
		*) die "FRONTEND_MODE must be proxy, direct or legacy" ;;
	esac
	if [ "$FRONTEND_MODE" != legacy ]; then
		ask MESHINFO_URL "meshinfo API URL (e.g. http://meshinfo-host:8090/api/v1/)" ""
		[ -n "$MESHINFO_URL" ] || die "A meshinfo API URL is required for $FRONTEND_MODE mode"
		[[ "$MESHINFO_URL" == */ ]] || MESHINFO_URL="$MESHINFO_URL/"
	fi
fi

section "Summary"
echo "  Install:      $COMPONENTS"
echo "  User:         $SERVICE_USER"
echo "  nginx:        $WITH_NGINX"
[ "$COMPONENTS" = frontend ] && echo "  Data source:  $FRONTEND_MODE ${MESHINFO_URL:-}"
echo "  Repository:   $REPO_URL ($BRANCH)"
echo "  Checkout:     $INSTALL_DIR"
echo ""
ask_yn PROCEED "Install now?" yes
[ "$PROCEED" = yes ] || exit 1

section "Base packages"
apt-get update -qq
apt-get install -y -qq git ca-certificates sudo curl python3 > /dev/null
ok "git, sudo, curl, python3"

section "User $SERVICE_USER"
if id "$SERVICE_USER" &>/dev/null; then
	say "$SERVICE_USER already exists"
else
	useradd -m -s /bin/bash -c "Nodographer" "$SERVICE_USER"
	ok "Created $SERVICE_USER"
fi
usermod -aG systemd-journal "$SERVICE_USER"
if [ "$SET_PASSWORD" = yes ]; then
	if [ "$ASSUME_YES" = 1 ] || [ "$TTY" != /dev/tty ]; then
		say "No terminal for a password prompt; set it later with: passwd $SERVICE_USER"
	else
		until passwd "$SERVICE_USER" <"$TTY"; do
			echo "Try again."
		done
	fi
	usermod -aG sudo "$SERVICE_USER"
	ok "$SERVICE_USER can log in and use sudo (with the password)"
fi
USER_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"

section "Repository"
cd /
if [ -d "$INSTALL_DIR/.git" ]; then
	OWNER="$(stat -c %U "$INSTALL_DIR/.git")"
	say "Updating existing checkout (owner $OWNER)"
	sudo -H -u "$OWNER" git -C "$INSTALL_DIR" fetch -q origin
	sudo -H -u "$OWNER" git -C "$INSTALL_DIR" checkout -q "$BRANCH"
	sudo -H -u "$OWNER" git -C "$INSTALL_DIR" pull -q --ff-only
else
	if [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR")" ]; then
		die "$INSTALL_DIR exists and is not empty"
	fi
	install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$INSTALL_DIR"
	sudo -H -u "$SERVICE_USER" git clone -q -b "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi
ok "$INSTALL_DIR @ $(git -c safe.directory="$INSTALL_DIR" -C "$INSTALL_DIR" rev-parse --short HEAD)"

# shellcheck source=lib/install-common.sh
source "$INSTALL_DIR/lib/install-common.sh"

if [ "$WITH_NGINX" = yes ]; then
	section "nginx"
	apt-get install -y -qq nginx > /dev/null
	if [ "$WANT_FRONTEND" = yes ]; then
		ROOT_REDIRECT=/meshmap/
	else
		ROOT_REDIRECT=/api/v1/status.json
	fi
	render_template "$INSTALL_DIR/lib/nginx-site.conf" /etc/nginx/sites-available/nodographer \
		"ROOT_REDIRECT=$ROOT_REDIRECT"
	ln -sfn /etc/nginx/sites-available/nodographer /etc/nginx/sites-enabled/nodographer
	rm -f /etc/nginx/sites-enabled/default
	systemctl enable --now nginx > /dev/null 2>&1
	nginx -t 2>/dev/null && systemctl reload nginx
	ok "nginx serves /var/www/html with the Nodographer site (/ -> $ROOT_REDIRECT)"
fi

if [ "$WANT_MESHINFO" = yes ]; then
	section "meshinfo"
	CONFIG="$INSTALL_DIR/meshinfo/meshinfo.toml"
	if [ -f "$CONFIG" ]; then
		DB_PASS="$(sed -n 's/^password = "\(.*\)"$/\1/p' "$CONFIG" | head -n 1)"
	else
		DB_PASS="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-24)"
	fi
	export SERVICE_USER
	CONFIG_OWNER="$SERVICE_USER" DB_PASS="$DB_PASS" "$INSTALL_DIR/meshinfo/INSTALL.sh" -y

	API_PORT="$("$INSTALL_DIR/meshinfo/venv/bin/python3" -c "import sys; sys.path.insert(0, '$INSTALL_DIR/meshinfo'); from meshinfo_config import ConfigManager; print(ConfigManager('$CONFIG').getint('api', 'port', 8090))")"
	if [ "$WITH_NGINX" = yes ]; then
		render_template "$INSTALL_DIR/meshinfo/nginx-api.conf" /etc/nginx/snippets/nodographer-api.conf \
			"API_PORT=$API_PORT"
		nginx -t 2>/dev/null && systemctl reload nginx
		ok "nginx publishes the API at /api/v1/"
	fi

	# Lets the user apply settings from ~/nodographer-setup without a password
	cat > /etc/sudoers.d/nodographer <<EOF
# Written by Nodographer lxc-install.sh
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart meshinfo-poller.service meshinfo-api.service
EOF
	chmod 440 /etc/sudoers.d/nodographer
	visudo -cqf /etc/sudoers.d/nodographer || die "Invalid /etc/sudoers.d/nodographer"
	ok "$SERVICE_USER may restart the meshinfo services"

	for unit in meshinfo-poller.service meshinfo-api.service; do
		if ! systemctl is-active --quiet "$unit" && \
			[ "$(systemctl show -p ExecMainStatus --value "$unit")" = 226 ]; then
			say "$unit could not set up its sandbox (status 226/NAMESPACE)."
			echo "  In Proxmox, enable Options > Features > Nesting for this container, restart it,"
			echo "  then run: systemctl restart meshinfo-poller.service meshinfo-api.service"
		fi
	done
fi

if [ "$WANT_FRONTEND" = yes ]; then
	section "Frontend"
	ARGS=(-y)
	if [ "$COMPONENTS" = both ]; then
		ARGS+=(--mode local)
	else
		ARGS+=(--mode "$FRONTEND_MODE")
		[ -n "${MESHINFO_URL:-}" ] && ARGS+=(--meshinfo-url "$MESHINFO_URL")
	fi
	[ "$WITH_NGINX" = yes ] || ARGS+=(--no-web-server)
	CONFIG_OWNER="$SERVICE_USER" "$INSTALL_DIR/frontend/INSTALL.sh" "${ARGS[@]}"
	if [ -n "${MESHINFO_URL:-}" ]; then
		if curl -fsS -m 10 "${MESHINFO_URL}status.json" > /dev/null 2>&1; then
			ok "meshinfo API answers at ${MESHINFO_URL}status.json"
		else
			say "Could not read ${MESHINFO_URL}status.json yet; the map stays empty until it is reachable."
		fi
	fi
fi

ln -sfn "$INSTALL_DIR/setup.sh" "$USER_HOME/nodographer-setup"
chown -h "$SERVICE_USER:$SERVICE_USER" "$USER_HOME/nodographer-setup"

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
IP="${IP:-$(hostname)}"
section "Installed"
if [ "$WANT_FRONTEND" = yes ] && [ "$WITH_NGINX" = yes ]; then
	echo "  Map:          http://$IP/meshmap/"
fi
if [ "$WANT_MESHINFO" = yes ]; then
	echo "  meshinfo API: http://$IP:$API_PORT/api/v1/status.json"
	[ "$WITH_NGINX" = yes ] && echo "                http://$IP/api/v1/status.json"
	echo "  Logs:         journalctl -fu meshinfo-poller.service"
fi
case "$VIRT" in
	lxc|none|"") ;;
	*) say "Detected container type '$VIRT' (expected lxc or a VM)." ;;
esac
echo ""
echo "Next, configure it as $SERVICE_USER:"
echo ""
if [ "$SET_PASSWORD" = yes ]; then
	echo "    ssh $SERVICE_USER@$IP        (or from this root shell: su - $SERVICE_USER)"
else
	echo "    su - $SERVICE_USER"
fi
echo "    ./nodographer-setup"
echo ""
if [ "$WANT_MESHINFO" = yes ]; then
	echo "The scanner is already running with default settings. Until setup points it at"
	echo "a reachable AREDN node and the first scan finishes, the map has no nodes."
fi
echo "Update later with: $INSTALL_DIR/update.sh"
