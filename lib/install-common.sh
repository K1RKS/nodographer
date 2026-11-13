# Shared helpers for the Nodographer / meshinfo install and update scripts.
# Source this file; it does not run anything by itself.

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

require_root() {
	if [[ ${EUID} -ne 0 ]]; then
		print_error "This script must be run as root (use sudo)"
		exit 1
	fi
}

# confirm "Question?"  -> returns 0 for yes. ASSUME_YES=1 skips the prompt.
confirm() {
	if [ "${ASSUME_YES:-0}" = "1" ]; then
		return 0
	fi
	local reply
	read -r -p "$1 (y/n) " -n 1 reply
	echo
	[[ $reply =~ ^[Yy]$ ]]
}

# render_template SRC DEST KEY=VALUE...  replaces @KEY@ with VALUE
render_template() {
	local src="$1" dest="$2"
	shift 2
	local content
	content="$(cat "$src")"
	local pair key value
	for pair in "$@"; do
		key="${pair%%=*}"
		value="${pair#*=}"
		content="${content//@${key}@/${value}}"
	done
	printf '%s\n' "$content" > "$dest"
}

# Group used by the local web server, for read access to the meshinfo data dir
web_group() {
	if getent group www-data >/dev/null; then
		echo www-data
	elif getent group nginx >/dev/null; then
		echo nginx
	elif getent group apache >/dev/null; then
		echo apache
	else
		echo ""
	fi
}
