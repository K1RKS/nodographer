#!/bin/bash
#
# Refresh an installed meshinfo after the checkout changed (git pull):
# reinstalls Python requirements, re-renders the systemd units, migrates a
# legacy meshmapPoller install, publishes a snapshot and restarts services.
#
# Usage: sudo meshinfo/update.sh [--no-start]
#
# To pull from git as well, use the top-level update.sh.
#
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/INSTALL.sh" --update "$@"
