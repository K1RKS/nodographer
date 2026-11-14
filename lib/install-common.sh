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

# http_status URL: HTTP status of a HEAD request for URL, 000 when nothing answers
http_status() {
	curl -s -o /dev/null -I --connect-timeout 5 -m 10 -w '%{http_code}' "$1" 2>/dev/null || true
}

# meshinfo_probe URL: prints ok (map data available), nodata (meshinfo answers
# but has not published a scan yet) or the HTTP status of map_data.json
meshinfo_probe() {
	local code
	code="$(http_status "${1}map_data.json")"
	if [ "$code" = 200 ]; then
		echo ok
	elif [ "$code" = 503 ] || [ "$(http_status "${1}status.json")" = 200 ]; then
		echo nodata
	else
		echo "$code"
	fi
}

# check_meshinfo_url URL: tests a meshinfo API URL (ending in /) from this host.
# Returns 0 when it answers. Otherwise sets SUGGESTED_URL to a nearby URL on
# the same host that does answer (standard /api/v1/ path, default port 8090).
check_meshinfo_url() {
	local url="$1" rest scheme hostport host path result cand
	SUGGESTED_URL=""
	if [[ ! "$url" =~ ^https?://[^/]+/ ]]; then
		print_error "$url is not an http:// or https:// URL"
		return 1
	fi
	scheme="${url%%://*}"
	rest="${url#*://}"
	hostport="${rest%%/*}"
	path="/${rest#*/}"
	host="$hostport"
	[[ "$hostport" =~ ^(.*):[0-9]+$ ]] && host="${BASH_REMATCH[1]}"
	if [[ "$path" != */api/v1/ ]]; then
		print_step "The path $path does not end in /api/v1/, where meshinfo serves its API."
	fi
	if ! command -v curl >/dev/null; then
		print_step "curl is not installed; not testing $url"
		return 0
	fi
	print_step "Testing $url ..."
	result="$(meshinfo_probe "$url")"
	case "$result" in
		ok)
			print_success "meshinfo answers at $url"
			return 0 ;;
		nodata)
			print_success "meshinfo answers at $url (no scan published yet; the map fills in after the first one)"
			return 0 ;;
		000) print_error "No answer from $hostport (wrong host name or port, or it is down)" ;;
		*) print_error "$hostport answered HTTP $result for ${url}map_data.json; check the path (normally /api/v1/)" ;;
	esac
	for cand in "$scheme://$hostport/api/v1/" "$scheme://$host:8090/api/v1/"; do
		[ "$cand" = "$url" ] && continue
		[ "$result" = 000 ] && [[ "$cand" == "$scheme://$hostport/"* ]] && continue
		case "$(meshinfo_probe "$cand")" in
			ok|nodata)
				# shellcheck disable=SC2034
				SUGGESTED_URL="$cand"
				print_success "meshinfo does answer at $cand"
				break ;;
		esac
	done
	return 1
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
