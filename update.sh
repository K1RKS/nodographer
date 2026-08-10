#!/bin/bash
#
# Nodographer Update Script
# -------------------------
# Updates an already-installed Nodographer tree from git, refreshes Python
# dependencies, and restarts the poller service.
#
# Usage:
#   sudo ./update.sh
#   sudo INSTALL_DIR=/srv/meshmap ./update.sh
#   sudo BRANCH=main ./update.sh
#   sudo ./update.sh --force          # allow dirty working tree (still prefers ff-only)
#
# Defaults:
#   INSTALL_DIR  /srv/meshmap (or the directory containing this script if it is a git checkout)
#   BRANCH       current checkout branch (fetch + ff-only pull)
#

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_header() {
	echo -e "\n${GREEN}===================================================================${NC}"
	echo -e "${GREEN}$1${NC}"
	echo -e "${GREEN}===================================================================${NC}\n"
}

print_step() {
	echo -e "${YELLOW}➜${NC} $1"
}

print_success() {
	echo -e "${GREEN}✓${NC} $1"
}

print_error() {
	echo -e "${RED}✗${NC} $1"
}

FORCE=0
for arg in "$@"; do
	case "$arg" in
		--force|-f) FORCE=1 ;;
		-h|--help)
			sed -n '2,18p' "$0"
			exit 0
			;;
		*)
			print_error "Unknown argument: $arg"
			exit 1
			;;
	esac
done

if [[ ${EUID} -ne 0 ]]; then
	print_error "This script must be run as root (use sudo)"
	exit 1
fi

ACTUAL_USER="${SUDO_USER:-$USER}"
if [ "$ACTUAL_USER" = "root" ]; then
	print_error "Please run this script with sudo from a regular user account, not as root"
	exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Prefer an explicit INSTALL_DIR; else the script's directory if it is a clone; else /srv/meshmap
if [ -n "${INSTALL_DIR:-}" ]; then
	:
elif [ -d "$SCRIPT_DIR/.git" ]; then
	INSTALL_DIR="$SCRIPT_DIR"
else
	INSTALL_DIR="/srv/meshmap"
fi

SERVICE_NAME="meshmapPoller.service"
WEB_LINK="/var/www/html/meshmap"

print_header "Nodographer Update Script"
echo "Install directory: $INSTALL_DIR"
echo "Service:           $SERVICE_NAME"
echo "Requested by:      $ACTUAL_USER"
echo ""

if [ ! -d "$INSTALL_DIR" ]; then
	print_error "Install directory not found: $INSTALL_DIR"
	exit 1
fi

if [ ! -d "$INSTALL_DIR/.git" ]; then
	print_error "$INSTALL_DIR is not a git checkout (.git missing)"
	exit 1
fi

cd "$INSTALL_DIR"

# Run git as the owner of the working tree when possible (avoid root-owned files)
GIT_OWNER="$(stat -c '%U' "$INSTALL_DIR/.git" 2>/dev/null || echo root)"
run_git() {
	if [ "$GIT_OWNER" = "root" ] || [ -z "$GIT_OWNER" ]; then
		git -C "$INSTALL_DIR" "$@"
	else
		sudo -u "$GIT_OWNER" git -C "$INSTALL_DIR" "$@"
	fi
}

BEFORE_REV="$(run_git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BEFORE_BRANCH="$(run_git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
print_step "Current revision: $BEFORE_BRANCH @ $BEFORE_REV"

# Optional branch switch before pull
if [ -n "${BRANCH:-}" ] && [ "$BRANCH" != "$BEFORE_BRANCH" ]; then
	print_step "Switching to branch '$BRANCH'..."
	run_git fetch --prune origin
	run_git checkout "$BRANCH"
	BEFORE_BRANCH="$BRANCH"
fi

# Refuse a dirty tree unless --force (protects local settings.toml edits, etc.)
DIRTY="$(run_git status --porcelain)"
if [ -n "$DIRTY" ] && [ "$FORCE" -ne 1 ]; then
	print_error "Working tree has local changes. Commit/stash them, or re-run with --force."
	echo "$DIRTY"
	exit 1
fi
if [ -n "$DIRTY" ] && [ "$FORCE" -eq 1 ]; then
	print_step "Continuing with dirty working tree (--force)"
fi

# Stop poller before replacing code
print_header "Stopping poller"
if systemctl list-unit-files "$SERVICE_NAME" &>/dev/null || systemctl status "$SERVICE_NAME" &>/dev/null; then
	print_step "Stopping $SERVICE_NAME..."
	systemctl stop "$SERVICE_NAME" || true
	print_success "Service stopped (or was not running)"
else
	print_step "Service unit not installed yet; skipping stop"
fi

print_header "Updating from git"
print_step "Fetching origin..."
run_git fetch --prune origin

TRACKING="$(run_git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
if [ -z "$TRACKING" ]; then
	# No upstream: try origin/<branch>
	if run_git show-ref --verify --quiet "refs/remotes/origin/$BEFORE_BRANCH"; then
		print_step "No upstream set; pulling origin/$BEFORE_BRANCH with ff-only"
		run_git pull --ff-only origin "$BEFORE_BRANCH"
	else
		print_error "No upstream remote branch for '$BEFORE_BRANCH'"
		exit 1
	fi
else
	print_step "Fast-forward pull ($TRACKING)..."
	run_git pull --ff-only
fi

AFTER_REV="$(run_git rev-parse --short HEAD)"
AFTER_BRANCH="$(run_git rev-parse --abbrev-ref HEAD)"
if [ "$BEFORE_REV" = "$AFTER_REV" ]; then
	print_success "Already up to date ($AFTER_BRANCH @ $AFTER_REV)"
else
	print_success "Updated $BEFORE_REV → $AFTER_REV ($AFTER_BRANCH)"
	run_git --no-pager log --oneline "$BEFORE_REV..$AFTER_REV" || true
fi

print_header "Python dependencies"
if [ ! -x "$INSTALL_DIR/backend/venv/bin/pip" ]; then
	print_error "Missing venv at $INSTALL_DIR/backend/venv — re-run INSTALL.sh or recreate the venv"
	exit 1
fi

if id meshmap &>/dev/null; then
	print_step "Installing requirements as user meshmap..."
	chown -R meshmap:meshmap "$INSTALL_DIR/backend" "$INSTALL_DIR/.cache" 2>/dev/null || true
	sudo -H -u meshmap "$INSTALL_DIR/backend/venv/bin/pip" install --upgrade pip -q
	sudo -H -u meshmap "$INSTALL_DIR/backend/venv/bin/pip" install -r "$INSTALL_DIR/backend/requirements.txt" -q
else
	print_step "User meshmap not found; installing requirements with venv pip as root..."
	"$INSTALL_DIR/backend/venv/bin/pip" install --upgrade pip -q
	"$INSTALL_DIR/backend/venv/bin/pip" install -r "$INSTALL_DIR/backend/requirements.txt" -q
fi
print_success "Python dependencies refreshed"

print_header "Permissions and web link"
if id meshmap &>/dev/null; then
	chown -R meshmap:meshmap "$INSTALL_DIR/backend" 2>/dev/null || true
	if [ -d "$INSTALL_DIR/frontend/data" ]; then
		chown -R meshmap:www-data "$INSTALL_DIR/frontend/data"
		chmod 775 "$INSTALL_DIR/frontend/data"
	fi
fi

if [ ! -e "$WEB_LINK" ] && [ -d "$INSTALL_DIR/frontend" ]; then
	print_step "Restoring web symlink $WEB_LINK → $INSTALL_DIR/frontend"
	ln -sf "$INSTALL_DIR/frontend" "$WEB_LINK"
fi

# Keep systemd unit symlink current; reload if the unit file changed
if [ -f "$INSTALL_DIR/backend/meshmapPoller.service" ]; then
	if [ ! -e "/etc/systemd/system/$SERVICE_NAME" ]; then
		print_step "Creating systemd unit symlink..."
		ln -sf "$INSTALL_DIR/backend/meshmapPoller.service" "/etc/systemd/system/$SERVICE_NAME"
	fi
	print_step "Reloading systemd daemon..."
	systemctl daemon-reload
fi

print_header "Starting poller"
if [ -e "/etc/systemd/system/$SERVICE_NAME" ] || systemctl list-unit-files "$SERVICE_NAME" &>/dev/null; then
	systemctl start "$SERVICE_NAME"
	systemctl --no-pager --full status "$SERVICE_NAME" || true
	print_success "Update complete: $AFTER_BRANCH @ $AFTER_REV"
else
	print_step "No systemd unit present; code updated but service not started"
	print_success "Update complete: $AFTER_BRANCH @ $AFTER_REV"
fi

echo ""
echo "Tips:"
echo "  journalctl -u $SERVICE_NAME -f"
echo "  Map UI: http://<host>/meshmap/"
echo ""
