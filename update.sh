#!/bin/bash
#
# Nodographer Update Script
# -------------------------
# Updates an installed Nodographer checkout from git, then refreshes whichever
# parts are installed on this VM:
#   meshinfo  venv, systemd units, legacy migration, restart (meshinfo/update.sh)
#   frontend  served straight from the checkout; config created if missing
#
# The meshinfo API keeps serving the last published snapshot while the poller
# is stopped for the update.
#
# Usage:
#   sudo ./update.sh
#   sudo INSTALL_DIR=/srv/meshmap ./update.sh
#   sudo BRANCH=main ./update.sh
#   sudo ./update.sh --force          # allow dirty working tree (still prefers ff-only)
#
# Defaults:
#   INSTALL_DIR  the directory containing this script if it is a git checkout, else /srv/meshmap
#   BRANCH       current checkout branch (fetch + ff-only pull)
#   WEB_LINK     /var/www/html/meshmap
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/install-common.sh
source "$SCRIPT_DIR/lib/install-common.sh"

FORCE=0
POST_PULL=0
for arg in "$@"; do
	case "$arg" in
		--force|-f) FORCE=1 ;;
		--post-pull) POST_PULL=1 ;;
		-h|--help)
			sed -n '2,24p' "$0"
			exit 0
			;;
		*)
			print_error "Unknown argument: $arg"
			exit 1
			;;
	esac
done

require_root

ACTUAL_USER="${SUDO_USER:-$USER}"
if [ "$ACTUAL_USER" = "root" ] && [ "${ALLOW_ROOT:-0}" != 1 ]; then
	print_error "Please run this script with sudo from a regular user account, not as root"
	exit 1
fi

# Prefer an explicit INSTALL_DIR; else the script's directory if it is a clone; else /srv/meshmap
if [ -n "${INSTALL_DIR:-}" ]; then
	:
elif [ -d "$SCRIPT_DIR/.git" ]; then
	INSTALL_DIR="$SCRIPT_DIR"
else
	INSTALL_DIR="/srv/meshmap"
fi

WEB_LINK="${WEB_LINK:-/var/www/html/meshmap}"
LEGACY_SERVICE="meshmapPoller.service"
POLLER_SERVICE="meshinfo-poller.service"

has_unit() {
	[ -e "/etc/systemd/system/$1" ] || systemctl list-unit-files "$1" 2>/dev/null | grep -q "^$1"
}

HAS_MESHINFO=0
if has_unit "$POLLER_SERVICE" || has_unit "$LEGACY_SERVICE"; then
	HAS_MESHINFO=1
fi
HAS_FRONTEND=0
if [ -L "$WEB_LINK" ] && [ "$(readlink -f "$WEB_LINK")" = "$(readlink -f "$INSTALL_DIR/frontend")" ]; then
	HAS_FRONTEND=1
fi

print_header "Nodographer Update Script"
echo "Install directory: $INSTALL_DIR"
echo "meshinfo:          $([ $HAS_MESHINFO = 1 ] && echo installed || echo 'not installed')"
echo "frontend:          $([ $HAS_FRONTEND = 1 ] && echo "installed ($WEB_LINK)" || echo 'not installed')"
echo "Requested by:      $ACTUAL_USER"
echo ""

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

if [ "$POST_PULL" = 0 ]; then
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

	# Refuse a dirty tree unless --force
	DIRTY="$(run_git status --porcelain --untracked-files=no)"
	if [ -n "$DIRTY" ] && [ "$FORCE" -ne 1 ]; then
		print_error "Working tree has local changes. Commit/stash them, or re-run with --force."
		echo "$DIRTY"
		exit 1
	fi
	if [ -n "$DIRTY" ] && [ "$FORCE" -eq 1 ]; then
		print_step "Continuing with dirty working tree (--force)"
	fi

	if [ "$HAS_MESHINFO" = 1 ]; then
		print_header "Stopping poller"
		for svc in "$LEGACY_SERVICE" "$POLLER_SERVICE"; do
			systemctl stop "$svc" 2>/dev/null || true
		done
		print_success "Poller stopped (the API keeps serving the last snapshot)"
	fi

	print_header "Updating from git"
	SELF_BEFORE="$(sha256sum "$INSTALL_DIR/update.sh" | cut -d' ' -f1)"
	print_step "Fetching origin..."
	run_git fetch --prune origin

	TRACKING="$(run_git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
	if [ -z "$TRACKING" ]; then
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

	# Continue with the freshly pulled version of this script
	if [ "$(sha256sum "$INSTALL_DIR/update.sh" | cut -d' ' -f1)" != "$SELF_BEFORE" ]; then
		print_step "update.sh changed; continuing with the new version"
		exec "$INSTALL_DIR/update.sh" --post-pull
	fi
fi

if [ "$HAS_MESHINFO" = 1 ]; then
	"$INSTALL_DIR/meshinfo/INSTALL.sh" --update
fi

if [ "$HAS_FRONTEND" = 1 ] && [ ! -f "$INSTALL_DIR/frontend/config/nodographer.json" ]; then
	print_header "Frontend configuration"
	if [ "$HAS_MESHINFO" = 1 ]; then
		"$INSTALL_DIR/frontend/INSTALL.sh" -y --mode local --web-root "$(dirname "$WEB_LINK")" --web-name "$(basename "$WEB_LINK")"
	else
		"$INSTALL_DIR/frontend/INSTALL.sh" -y --mode legacy --web-root "$(dirname "$WEB_LINK")" --web-name "$(basename "$WEB_LINK")"
	fi
fi

print_success "Update complete: $(run_git rev-parse --abbrev-ref HEAD) @ $(run_git rev-parse --short HEAD)"
echo ""
echo "Tips:"
[ "$HAS_MESHINFO" = 1 ] && echo "  journalctl -u $POLLER_SERVICE -f"
[ "$HAS_FRONTEND" = 1 ] && echo "  Map UI: http://<host>/$(basename "$WEB_LINK")/"
echo ""
