# Nodographer

**Babel Aware AREDN Mesh Map**

An olsr/babel-compatible Python rewrite and derivative work of the original meshmap web application by KG6WXC.

## Overview

Nodographer is a mesh mapping web app and API made of two parts. They can run on the same VM or on two different VMs:

- **meshinfo** (`meshinfo/`): the scanner and data API.
  - `meshinfo-poller.service` is a Python async daemon. It polls AREDN nodes, collects network topology and node data, and keeps the node database (MariaDB/MySQL).
  - After every successful scan it publishes the results as one **snapshot**: `map_data.json`, `node_report_data.json`, `nodes.kml`, `nodes.csv` and `nodes.json`.
  - `meshinfo-api.service` is a small read-only HTTP API that serves the current snapshot.
- **Frontend** (`frontend/`): a static, Leaflet-based map with grouped layer controls, search, and a detailed node report page. It reads the snapshot from a configurable **base URL**. That can be a local path on the same VM, or the meshinfo API on another VM.

```
meshinfo VM
  meshinfo-poller  -- polls mesh, writes -->  MariaDB
                   -- publishes ---------->  /var/lib/meshinfo/
                                                current -> snapshots/<id>/   (last good scan)
                                                snapshots/<id>/              (map_data.json, ...)
                                                status.json                  (scanning / idle / failed)
  meshinfo-api :8090  -- serves current/ and status.json as /api/v1/...

frontend VM (can be the same VM)
  nginx -> frontend/ (static map) -- reads config/nodographer.json "meshinfo.baseUrl":
           "meshinfo/current/"        local: symlink to /var/lib/meshinfo
           "meshinfo/"                nginx proxy to http://meshinfo-host:8090/api/v1/
           "https://host/api/v1/"     browser fetches the meshinfo API directly
```

**The last good scan is always available.** The poller builds every file of a scan in a new `snapshots/<id>/` directory, then atomically swaps the `current` symlink to point at it. Readers (the API, the web server, rsync) always get a complete, consistent set from the last successful scan. A scan that is still running, fails, or is rejected by a sanity check never replaces it; the data simply "updates" when the next scan completes.

The code lives in one git checkout (for example `/srv/meshmap`). Each VM installs only the part it needs.

## System Requirements

- Linux with systemd (developed and tested on Debian 13, works on any systemd-based distribution)
- `git`
- **meshinfo VM:** Python 3.10 or higher with `python3-venv`, MariaDB/MySQL, and `traceroute`. The installer uses `apt`, so Debian or Ubuntu.
- **frontend VM:** a web server (Nginx used for development and testing) and `python3` (used by the installer only; installed if missing)

## Features

- **Split or combined deployment**: scanner and map on one VM, or on separate VMs
- **Last-good snapshots**: published atomically; failed or partial scans never replace good data
- **Read-only data API** with ETag/304, gzip, CORS and a `status.json` scan-state endpoint
- **Comprehensive Logging**: Integrated with systemd journal (INFO, DEBUG, ERROR levels)
- **Flush Mode**: `--flush` flag clears stale data and resets node state

## Installation

### Clone the repository

On every VM that runs either part:

```bash
sudo apt update && sudo apt install -y git
sudo git clone https://github.com/AI7BQ/nodographer.git /srv/meshmap
sudo chown -R "$USER":"$USER" /srv/meshmap
```

Keep the checkout somewhere the web server and the `meshmap` service user can read, such as `/srv/meshmap`. Avoid a home directory: many distributions make home directories private, and the services are sandboxed with `ProtectHome=read-only`. The checkout can be owned by your login user (`update.sh` runs `git` as the owner). The installers also work when run directly as root.

### Quick start

| Layout | Command |
| --- | --- |
| Everything on one VM | `sudo /srv/meshmap/INSTALL.sh` |
| meshinfo VM (scanner + API) | `sudo /srv/meshmap/INSTALL.sh --meshinfo` |
| Frontend VM | `sudo /srv/meshmap/INSTALL.sh --frontend` (prompts for the data source) |

The installers are safe to re-run. `-y` skips the prompts.

For a split install, set up the meshinfo VM first. Then open the API port to the frontend VM (TCP 8090 by default, for example `sudo ufw allow from <frontend-ip> to any port 8090 proto tcp`), and install the frontend VM in `proxy` or `direct` mode.

### After installing: configure and restart

The installer starts the services with default settings, so set at least the topology node before you expect a map:

1. Edit `/srv/meshmap/meshinfo/meshinfo.toml` and set `[polling] nodelistNode` to an AREDN node this VM can reach, for example `localnode.local.mesh` when the VM sits behind a mesh node and uses its DNS. If you set `DB_PASS` during install, the password is already filled in.
2. Restart the scanner: `sudo systemctl restart meshinfo-poller.service`.
3. On the frontend VM, edit `/srv/meshmap/frontend/config/nodographer.json` for the map title, center, zoom, units and tile servers. These are static files, so a browser reload picks up the changes; no restart is needed.

The first scan polls every node at full speed and can take several minutes on a large mesh. Until it finishes there is no snapshot: the API answers `503` and the map has no nodes. Watch progress with `sudo journalctl -fu meshinfo-poller.service` or `curl -s http://localhost:8090/api/v1/status.json`.

The top-level `settings.toml` is the legacy single-file config. New installs do not use it; it is only read when migrating an old install (see [Migrating from a single `meshmapPoller` install](#migrating-from-a-single-meshmappoller-install)).

**`meshinfo/INSTALL.sh`** does the following:
- Installs Python, MariaDB and `traceroute` (used for hop counts).
- Creates the `meshmap` service user, the `meshinfo/venv` virtual environment, and the database.
- Writes `meshinfo/meshinfo.toml` from `meshinfo.example.toml`.
- Creates the data directory `/var/lib/meshinfo` (owner `meshmap`, group `www-data`, mode `2750`).
- Renders and starts `meshinfo-poller.service` and `meshinfo-api.service`.

Environment overrides: `DATA_DIR`, `SERVICE_USER`, `DB_NAME`, `DB_USER`, `DB_PASS`.

**`frontend/INSTALL.sh`** does the following:
- Symlinks `frontend/` into the web root (`/var/www/html/meshmap`).
- Writes `frontend/config/nodographer.json`.
- Sets up one of these data source modes:

| Mode | When to use | `meshinfo.baseUrl` | What the installer sets up |
| --- | --- | --- | --- |
| `local` | meshinfo on the same VM | `meshinfo/current/` | Symlink `frontend/meshinfo` to the data dir, plus an optional nginx snippet (no-cache, KML type) |
| `proxy` | meshinfo on another VM, best for HTTPS sites | `meshinfo/` | nginx snippet proxying `/meshmap/meshinfo/` to the remote API |
| `direct` | meshinfo on another VM, browser fetches it | `https://meshinfo-host/api/v1/` | Nothing; meshinfo must allow your origin (CORS) and use HTTPS if your site does |
| `legacy` | Poller output copied into `frontend/data/` by rsync | `data/` | Nothing |

Examples:

```bash
sudo frontend/INSTALL.sh --mode local
sudo frontend/INSTALL.sh --mode proxy  --meshinfo-url http://meshinfo-host.local.mesh:8090/api/v1/
sudo frontend/INSTALL.sh --mode direct --meshinfo-url https://meshinfo.example.org/api/v1/
```

In `proxy` mode the browser only talks to the frontend host. That avoids CORS and the mixed-content blocking you would get from an HTTPS map fetching a plain-HTTP meshinfo on the mesh. The installer writes `/etc/nginx/snippets/nodographer-meshinfo.conf`. If your server block does not include it yet, add the line it prints (`include snippets/nodographer-meshinfo.conf;`) and reload nginx.

### Manual installation

**meshinfo VM:**

```bash
sudo apt install -y python3 python3-venv python3-pip mariadb-server traceroute
sudo useradd -r -s /bin/false -d /srv/meshmap/meshinfo -c "meshinfo poller" meshmap

cd /srv/meshmap/meshinfo
sudo python3 -m venv venv
sudo venv/bin/pip install -r requirements.txt

sudo mysql -u root <<'SQL'
CREATE DATABASE IF NOT EXISTS node_map CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'mesh-map'@'localhost' IDENTIFIED BY 'password';
GRANT ALL PRIVILEGES ON node_map.* TO 'mesh-map'@'localhost';
FLUSH PRIVILEGES;
SQL

sudo cp meshinfo.example.toml meshinfo.toml            # then edit it
sudo chown root:meshmap meshinfo.toml && sudo chmod 640 meshinfo.toml
sudo install -d -o meshmap -g www-data -m 2750 /var/lib/meshinfo

# Render the unit templates (@INSTALL_DIR@, @DATA_DIR@, @SERVICE_USER@)
for u in meshinfo-poller.service meshinfo-api.service; do
  sed -e 's|@INSTALL_DIR@|/srv/meshmap|g' -e 's|@DATA_DIR@|/var/lib/meshinfo|g' \
      -e 's|@SERVICE_USER@|meshmap|g' "$u" | sudo tee /etc/systemd/system/$u >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable --now meshinfo-poller.service meshinfo-api.service
```

The database tables are created automatically when the poller first connects. For security the poller runs as the dedicated `meshmap` system user, with no login shell and write access only to the data directory. The API service is read-only: no database access, no raw sockets, no writes.

**Frontend VM (local mode shown):**

```bash
sudo apt install -y nginx
sudo ln -s /srv/meshmap/frontend /var/www/html/meshmap
sudo ln -s /var/lib/meshinfo /srv/meshmap/frontend/meshinfo
cp /srv/meshmap/frontend/config/nodographer.example.json /srv/meshmap/frontend/config/nodographer.json
```

For `proxy` mode, set `"baseUrl": "meshinfo/"` in `nodographer.json`, and add a `location` block like [`frontend/deploy/nginx-proxy.conf`](frontend/deploy/nginx-proxy.conf) to your nginx server block.

### Smoke test

On the meshinfo VM, once the first scan has finished:

```bash
systemctl is-active meshinfo-poller.service meshinfo-api.service
curl -s http://localhost:8090/api/v1/status.json   # "state": "idle", "currentSnapshot": "<id>"
ls -l /var/lib/meshinfo/current/                   # map_data.json, nodes.kml, ...
curl -s http://localhost:8090/healthz              # {"ok": true, ...}
```

On the frontend VM:

```bash
curl -sI http://localhost/meshmap/config/nodographer.json | head -1
curl -s  http://localhost/meshmap/meshinfo/current/map_data.json | head -c 200   # local mode
curl -s  http://localhost/meshmap/meshinfo/map_data.json | head -c 200           # proxy mode
```

Then open `http://<hostname>/meshmap/`.

To run a single scan by hand, stop the service first so two pollers don't run at once:

```bash
sudo systemctl stop meshinfo-poller.service
cd /srv/meshmap/meshinfo && sudo -u meshmap venv/bin/python3 meshinfoPoller.py --once
sudo systemctl start meshinfo-poller.service
```

### Service management

```bash
sudo systemctl status meshinfo-poller.service meshinfo-api.service
sudo systemctl restart meshinfo-poller.service        # Restart the scanner
sudo journalctl -u meshinfo-poller.service -f         # Follow scanner logs
sudo journalctl -u meshinfo-api.service -f            # Follow API logs
sudo journalctl -u meshinfo-poller.service -p err     # Errors only
```

Restarting or stopping the poller does not interrupt the API. It keeps serving the last published snapshot.

### Upgrades

On every VM with a checkout:

```bash
cd /srv/meshmap
sudo ./update.sh
```

Optional:

```bash
sudo BRANCH=main ./update.sh          # switch branch then ff-only pull
sudo INSTALL_DIR=/srv/meshmap ./update.sh
sudo ./update.sh --force              # allow dirty working tree
```

`update.sh` does the following:
- Stops the poller. The API keeps serving the last snapshot.
- Fast-forward pulls git.
- Runs `meshinfo/update.sh`, which refreshes the venv, re-renders the systemd units, publishes a snapshot from the database, and restarts both services.
- Creates `frontend/config/nodographer.json` if it is missing.

The real config files (`meshinfo/meshinfo.toml`, `frontend/config/nodographer.json`) are gitignored, so pulls never touch them.

#### Migrating from a single `meshmapPoller` install

Run `sudo ./update.sh` as usual. The **old** `update.sh` stops with a pip error after it pulls, because `backend/` was renamed to `meshinfo/`. That is expected: run `sudo ./update.sh` once more and the new script finishes the migration. It:

1. Stops, disables and removes `meshmapPoller.service`, and deletes the old `backend/venv`.
2. Splits `settings.toml` with `meshinfo/tools/migrate_settings.py`. Scanner settings go to `meshinfo/meshinfo.toml`. Map settings (tile servers, center, zoom, titles, units) go to `frontend/config/nodographer.json`.
3. Creates `/var/lib/meshinfo`, then installs and enables `meshinfo-poller.service` and `meshinfo-api.service`.
4. Publishes a snapshot from the existing database (`meshinfoPoller.py --publish-only`), so the map has data right away.
5. Switches the frontend to local mode (`frontend/meshinfo` points to `/var/lib/meshinfo`).

The old `frontend/data/*.json` files are no longer written and can be deleted.

To move the frontend to its own VM later:
1. Clone the repo there and run `sudo ./INSTALL.sh --frontend` in `proxy` or `direct` mode, pointing at `http://<meshinfo-host>:8090/api/v1/`.
2. Copy `frontend/config/nodographer.json` across to keep your map settings, keeping the new `baseUrl`.

**rsync-fed frontend hosts** (`legacy` mode) keep working. They need a `frontend/config/nodographer.json` with the map settings, because new snapshots no longer carry tile servers or the map center. Copy from the snapshot, dereferencing the symlink:

```bash
rsync -aL --delete-after --exclude tileservers.local.json --exclude .gitkeep \
    meshinfo-host:/var/lib/meshinfo/current/ /var/www/html/meshmap/data/
```

### Running as a different user

Set `SERVICE_USER=www-data` (or another user) when running `meshinfo/INSTALL.sh`. The installer renders the unit files and data directory ownership for that user.

### SELinux/AppArmor

If SELinux or AppArmor is enforcing:
- Allow the poller to write the meshinfo data directory (`/var/lib/meshinfo`).
- Allow the web server to read `/srv/meshmap/frontend` and, in local mode, `/var/lib/meshinfo`.

Policy adjustments are environment-specific.

### Uninstall

```bash
sudo systemctl disable --now meshinfo-poller.service meshinfo-api.service
sudo rm -f /etc/systemd/system/meshinfo-poller.service /etc/systemd/system/meshinfo-api.service
sudo systemctl daemon-reload
sudo rm -f /var/www/html/meshmap /etc/nginx/snippets/nodographer-*.conf
sudo rm -rf /var/lib/meshinfo /srv/meshmap
```

## Configuration

### meshinfo: `meshinfo/meshinfo.toml`

Copied from `meshinfo/meshinfo.example.toml`, which documents every option:

- `[database]`: connection and table names
- `[polling]`: `nodelistNode` (where topology is fetched), concurrency, `pollerCycleTime`
- `[hops]`: hop-count probing
- `[retention]`: how long nodes stay in the database and the published data
- `[publish]`:
  - `dataDir`: where snapshots and `status.json` are written (default `/var/lib/meshinfo`)
  - `keepSnapshots`: how many snapshots to keep (minimum 2)
  - `minNodeRatio`: refuse to publish a scan with fewer than this fraction of the previous snapshot's nodes; `0` disables the check
  - `exportTitle`: KML document name
- `[api]`: `listen`, `port` (default 8090), `allowOrigins` (CORS; `["*"]` by default)

If `meshinfo.toml` is missing, the poller falls back to the legacy `../settings.toml` and logs a warning.

### Frontend: `frontend/config/nodographer.json`

Copied from `frontend/config/nodographer.example.json`:

```json
{
  "meshinfo": { "baseUrl": "meshinfo/current/" },
  "map": {
    "title": "Nodographer Mesh Map",
    "centerLat": 43.97, "centerLon": -120.034, "initialZoom": 7,
    "distanceUnits": "miles",
    "contact": "", "attribution": "© OpenStreetMap contributors",
    "reportBrowserTitle": "Nodographer Node Report", "reportPageTitle": "Node Report",
    "geocoderUrl": "",
    "tileServers": { "inet.Street": "//{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" },
    "priority": ["inet.Street"],
    "defaultTileServer": "inet.Street"
  }
}
```

- `meshinfo.baseUrl` can be relative to the frontend root or absolute. See the modes table above. Without a config file it defaults to `data/`.
- Each `map` setting falls back first to the same value in `map_data.json` (snapshots from older pollers still carry them), then to built-in defaults.
- The legacy `frontend/data/tileservers.local.json` override is still applied last if present.

## Command Line Options

```bash
cd /srv/meshmap/meshinfo
./meshinfoPoller.py                  # Run in daemon mode
./meshinfoPoller.py --once           # Single poll cycle, publish, and exit
./meshinfoPoller.py --publish-only   # Publish a snapshot from the database (no polling) and exit
./meshinfoPoller.py --flush          # Clear stale data and reset node state
./meshinfoPoller.py --config FILE    # Use a specific config file
./meshinfoPoller.py --help           # Show help

./api.py [--config FILE] [--listen ADDR] [--port N]   # Run the API in the foreground

venv/bin/pip install -r requirements-dev.txt && venv/bin/python -m pytest   # Run the tests
```

## Web Interface

The frontend is accessed at `http://<server>/meshmap/` (after installation).

- **Map View**: Interactive Leaflet map showing nodes and links
- **Layer Control**: Toggle between AREDN and Internet tile servers
- **Search**: Find nodes by name or IP
- **Node Info**: Click on nodes to view details
- **Node Report**: Detailed statistics and filtering via `node_report/`

## Node Info
While viewing the map, click on any node circle to view details for that node. On the info tab you will find links to the various system information files.

### Combo OLSR/Babel Endpoints ###

- **Prometheus Metrics**: http://<node>/cgi-bin/metrics
- **System Information**: http://<node>/cgi-bin/sysinfo.json
- **Hosts**: http://<node>/cgi-bin/sysinfo.json?hosts=1
- **Services**: http://<node>/cgi-bin/sysinfo.json?services=1
- **Local Services**: http://<node>/cgi-bin/sysinfo.json?services_local=1
- **Link Information**: http://<node>/cgi-bin/sysinfo.json?link_info=1
- **Link Quality Manager**: http://<node>/cgi-bin/sysinfo.json?lqm=1
- **Nodes**: http://<node>/cgi-bin/sysinfo.json?nodes=1
- **Topology**: http://<node>/cgi-bin/sysinfo.json?topology=1

### Babel Only Endpoints ###

- **Prometheus Metrics**: http://<node>/cgi-bin/metrics
- **System Information**: http://<node>/a/sysinfo
- **Hosts**: http://<node>/a/sysinfo?hosts=1
- **Services**: http://<node>/a/sysinfo?services=1
- **Local Services**: http://<node>/a/sysinfo?services_local=1
- **Link Information**: http://<node>/a/sysinfo?link_info=1
- **Link Quality Manager**: http://<node>/a/sysinfo?lqm=1
- **Nodes**: http://<node>/a/sysinfo?nodes=1
- **Topology**: http://<node>/a/sysinfo?topology=1

## Architecture

### meshinfo Components

- **`meshinfo_config.ConfigManager`**: Configuration loading (shared by the poller and API)
- **`meshinfoPoller.NodeInfo`**: Data class for node state
- **`meshinfoPoller.MySQLAdapter`**: MySQL/MariaDB implementation
- **`meshinfoPoller.NodePoller`**: Individual node HTTP polling
- **`meshinfoPoller.MeshPollingDaemon`**: Main coordinator for all polling operations
- **`publisher.SnapshotPublisher`**: Atomic snapshot publishing, pruning and `status.json`
- **`exporters`**: KML / CSV / JSON node exports
- **`api`**: Read-only aiohttp service for the current snapshot

### Data Flow
When meshinfoPoller is started (or launched with the --once flag), the first pass for both MTR probing and node data fetching is performed at full speed in parallel. Subsequent passes are rate limited to reduce bursts of network traffic.

***Determine Hop Count to Each Node*** 
 1. Fetch network topology from localnode.local.mesh
 2. Add new nodes to the database
 3. Delete old nodes from the database
 4. Concurrently execute lightweight MTR test to all nodes in the database
 5. Update database with results

***Fetch JSON Data from Each Node***
 6. Concurrently fetch JSON data from all nodes in the database
 7. Update database with results
 8. Build all data files in memory and publish them as a new snapshot. `status.json` records `scanning` at the start of the cycle, then `idle`, `failed` or `rejected`.
 9. If `--once` flag is set then exit
10. Goto step 1

If topology can't be fetched, the cycle raises an error, or the new scan fails the `minNodeRatio` check, the previous snapshot stays current.

### Timezone Handling

Nodographer uses a **"Store UTC, Display Local"** architecture that works seamlessly with any server timezone:

- **Database**: MariaDB `TIMESTAMP` columns store all times internally as UTC (standard SQL behavior)
- **meshinfo**: `meshinfoPoller.py` converts all timestamps to ISO 8601 UTC format (`YYYY-MM-DDTHH:MM:SSZ`) when writing JSON files
- **Frontend**: JavaScript's `parseUTCTimestamp()` function parses the ISO 8601 UTC timestamp and JavaScript automatically converts it to the **operator's browser local timezone** for display

**Key Benefits**:
- ✅ Works globally—operators in any timezone (UTC, PST, IST, JST, etc.) see times in their local timezone automatically
- ✅ No configuration needed—timezone detection is automatic via the browser
- ✅ Portable data—timestamps remain independent of server location
- ✅ Works with any host system timezone—the server can be set to UTC or local time

**Example**: 
- Database stores: `2025-12-10 22:54:37` (always UTC internally)
- JSON output: `2025-12-10T22:54:37Z` (ISO 8601 UTC format)
- Browser in Tokyo (UTC+9): Displays as `2025-12-11 07:54:37` 
- Browser in Los Angeles (UTC-8): Displays as `2025-12-10 14:54:37`

This approach is industry-standard (AWS, Google Cloud, Azure all use UTC internally) and requires no additional configuration from the administrator.

## APIs and Data Files

### Snapshot Layout

Each successful scan is published under the meshinfo `dataDir` (default `/var/lib/meshinfo`):

```
/var/lib/meshinfo/
  current -> snapshots/20261113T024251Z     atomically swapped after each good scan
  snapshots/20261113T024251Z/
    map_data.json  node_report_data.json  nodes.kml  nodes.csv  nodes.json
    manifest.json                           snapshot id, timestamps, counts, sha256 per file
  status.json                               scan state, last success, last error
```

The last `keepSnapshots` snapshots are kept. Because a reader that opened files from the previous snapshot can finish reading it, a swap never breaks an in-flight request.

`status.json` fields:
- `state`: `scanning`, `idle`, `failed` or `rejected`
- `cycle`, `cycleStartedAt`
- `lastAttemptAt`, `lastSuccessAt`
- `currentSnapshot`, `lastError`
- `nextCycleExpectedAt`, `updatedAt`

### meshinfo API

`meshinfo-api.service` (default port 8090) serves the current snapshot. The file names match the snapshot directory, so a frontend can switch between a local path and the API by changing only `meshinfo.baseUrl`.

| Endpoint | Content |
| --- | --- |
| `GET /api/v1/map_data.json` | Map markers, links and poll statistics |
| `GET /api/v1/node_report_data.json` | Node report table |
| `GET /api/v1/nodes.kml`, `nodes.csv`, `nodes.json` | Node exports (below) |
| `GET /api/v1/manifest.json` | Current snapshot id, timestamps, counts, file hashes |
| `GET /api/v1/status.json` | `status.json` plus a `snapshot` summary and `ageSec` |
| `GET /healthz` | `200 {"ok":true,"snapshot":...}` once a snapshot exists, else `503` |

Snapshot files are sent with:
- `ETag` (the snapshot id plus the file name); `If-None-Match` returns `304`
- `Cache-Control: no-cache`
- `X-Meshinfo-Snapshot: <id>`
- gzip when the client accepts it
- the KML content type `application/vnd.google-earth.kml+xml`

CORS headers follow `[api] allowOrigins`. Before the first snapshot is published, data endpoints return `503` with `Retry-After`.

```bash
curl -s http://meshinfo-host:8090/api/v1/status.json | jq '{state, lastSuccessAt, ageSec, snapshot}'
curl -s http://meshinfo-host:8090/api/v1/map_data.json | jq '.pollingInfo'
```

### Snapshot Data Files

#### `map_data.json`
Contains all data needed for the interactive map visualization:
- **`mapInfo`**: Snapshot metadata
  - `localnode`, `lastUpdate`, `totalNodesInDB`, `weekPlusOld`, `snapshotId`, `schemaVersion`
  - Map presentation settings (tile servers, center, zoom, titles, units) are not in the snapshot; they come from `frontend/config/nodographer.json`. Snapshots from older pollers still carry them, and the frontend uses them as a fallback.
- **`pollingInfo`**: Polling statistics and node counts
  - Total nodes, successfully polled, response times
  - Protocol breakdown (OLSR, Babel, Combo)
  - Link counts, nodes with errors, nodes without location
- **`allDevices`**: All nodes organized by frequency band
  - `noRF`: Nodes without RF support
  - `supernode`: Supernode stations
  - `900`, `2.4`, `5`: Nodes by frequency band (MHz)
  - Each node includes: name, IP, lat/lon, firmware, model, status, links

#### `node_report_data.json`
Detailed node information for the interactive report page (DataTables format):
- Node callsign, IP address, coordinates
- Firmware version, model, hardware
- Uptime, load average, services
- Hops away, response time
- Tunnel status, antenna information
- Last seen timestamp

### AREDN Node APIs (Mesh Network)

Nodographer polls standard AREDN node API endpoints. These are accessed by the `NodePoller` class:

```
http://<node>/cgi-bin/sysinfo.json?nodes=1      # Node information from topology
http://<node>/cgi-bin/sysinfo.json?lqm=1        # Link quality metrics (preferred)
http://<node>/cgi-bin/sysinfo.json?link_info=1  # Link information (fallback)
```

These endpoints are polled from each node to gather:
- Node status, firmware version, model, hardware ID
- GPS location (latitude/longitude)
- Network interfaces and IP addresses
- Uptime, load average, services
- RF and antenna information

The topology endpoints are queried from the `nodelistNode` (configured in `meshinfo.toml`):
```
http://<nodelistNode>/cgi-bin/sysinfo.json?nodes=1      # All nodes in mesh
http://<nodelistNode>/cgi-bin/sysinfo.json?lqm=1        # Link quality metrics
http://<nodelistNode>/cgi-bin/sysinfo.json?link_info=1  # Detailed link info
```

### Nodographer Application Endpoints

Every snapshot file can be fetched over HTTP. `<base>` below depends on where you read from:

| Reading from | `<base>` |
| --- | --- |
| meshinfo API | `http://meshinfo-host:8090/api/v1` |
| Frontend in local mode | `http://frontend-host/meshmap/meshinfo/current` |
| Frontend in proxy mode | `http://frontend-host/meshmap/meshinfo` |
| Frontend in legacy (rsync) mode | `http://frontend-host/meshmap/data` |

#### Map Data Endpoint
```
GET <base>/map_data.json
```
Returns complete map visualization data including all nodes, links, and poll statistics. Used by the interactive map and can be consumed by external applications.

**Response Structure**:
- `mapInfo`: Snapshot metadata (`localnode`, `lastUpdate`, `snapshotId`, node counts)
- `pollingInfo`: Statistics (total nodes, response times, link counts, errors)
- `allDevices`: Nodes organized by frequency band (900MHz, 2.4GHz, 5GHz, etc.)

**Example**:
```bash
curl -s http://meshinfo-host:8090/api/v1/map_data.json | jq '.pollingInfo'
```

If you use Chrome, the "JSON Viewer" extension is highly recommended for viewing and searching JSON data in a clear, hierarchical tree structure.

#### Node Report Endpoint
```
GET <base>/node_report_data.json
```
Returns detailed tabular node data for the interactive report page. Contains per-node information suitable for DataTables filtering, sorting, and export.

**Response Format**: Array of objects, one per node:
```json
[
  {
    "callsign": "W5ABC",
    "ip": "10.89.88.45",
    "latitude": 35.1234,
    "longitude": -97.5678,
    "firmware": "3.2.1.0",
    "model": "Mikrotik RB912UAG-5HPnD",
    "uptime": "45 days",
    "tunnel": "none",
    "services": "http, ssh",
    "last_seen": "2025-01-15T12:34:56"
  },
  ...
]
```

#### Node Export Endpoints (KML, CSV, JSON)
```
GET <base>/nodes.kml
GET <base>/nodes.csv
GET <base>/nodes.json
```
The poller writes these files into every snapshot, next to `map_data.json`. Because a snapshot only goes live once all of its files are complete, a reader never gets a half-written file. The map legend links to all three (**Data: KML | CSV | JSON**). The layout follows the data downloads on [worldmap.arednmesh.org](https://worldmap.arednmesh.org/) (`data/out.{kml,csv,json}`).

- **`nodes.kml`**: every node shown on the map, in a **Nodes** folder with one subfolder per band (900 MHz, 2.4 GHz, 3.4 GHz, 5.8 GHz, Supernode, No RF), plus **Unpolled** for hosts seen only as link endpoints. Clicking a node shows its hardware, firmware, RF, IP and location details. A **Links** folder holds each link once, as a line: RF links grouped by band, DTD, Tunnel (TUN/WireGuard), XLINK and Supernode. Colors match the map. Besides the balloon fields, each node placemark carries machine-readable ExtendedData that the balloon does not show: `id`, `antHeight`, `antHeightRef` (always `agl`), `antAzimuth`, `antElevation`, `antGain` and `antBeam`. These are plain numbers, left empty when the node owner has not set them. `freq` is a number in MHz, or empty when unknown.
- **`nodes.csv`**: one row per polled node. The first columns match worldmap's CSV in the same order (`node,wlan_ip,last_seen,uptime,hardware,model,firmware_version,ssid,channel,mode,chanbw,active_tunnel_count,lat,lon,wifi_mac_address,board_id,firmware_mfg,lan_ip`). Nodographer then adds `band,freq,grid_square,description,hopsAway,protocol,mesh_supernode,mesh_gateway,antGain,antBeam,antAzimuth,antElevation,antHeight`. `mode` is always blank, `hardware` repeats `model`, and `last_seen` is ISO 8601 UTC. `freq` is in MHz (blank when unknown). `antHeight` is metres above ground, `antAzimuth` and `antElevation` are degrees, `antGain` is dBi and `antBeam` is degrees. Gain and beamwidth are `0` when the node reports no antenna.
- **`nodes.json`**: worldmap's layout, `{"version":"1","date":<epoch ms>,"units":{...},"nodeInfo":[{"data":{...}}]}`. Each `data` follows the AREDN sysinfo layout (`node`, `ip`, `lat`, `lon`, `gridsquare`, `node_details`, `tunnels`, `meshrf`, `sysinfo`). It also includes `id`, `antenna`, `lan_ip`, `wifi_mac_address`, `last_seen`, `band`, `hopsAway`, `protocol`, `services` and `links`.
  - `id` is the lowercased short hostname (for example `k1rks-hap-ac3`). It matches `links[].id`, so a link can be followed to its peer node.
  - `meshrf.freq` is a number in MHz, or `null` when unknown.
  - `antenna` is `{"height_m", "height_ref", "azimuth_deg", "elevation_deg", "gain_dbi", "beamwidth_deg", "description"}`. Each value is `null` when unset, and `0` is a real value. `height_ref` is always `"agl"`.
  - `links` is `[{hostname, id, linkType, distance_km, bearing_deg, signal_dbm, noise_dbm}]`. Distance and bearing (degrees from this node toward the peer) are only computed for RF links. Values are `null` when unknown.
  - The top-level `units` object lists the units: `{"height":"m","height_ref":"agl","freq":"MHz","distance":"km","azimuth":"deg","elevation":"deg","gain":"dBi","beamwidth":"deg","signal":"dBm"}`.

Antenna height comes from the node's **Antenna height above ground** setting (metres). AREDN does not report ground elevation or height above sea level, so tools that need an ASL height (for example Fresnel-zone profiles) must add ground elevation from a DEM.

The CSV and JSON include polled nodes that have no location. The KML can only place nodes that have coordinates.

**Google Earth Pro (live view):**
1. **Add > Network Link**.
2. Name it, and paste the full KML URL into **Link**, for example `http://meshinfo-host:8090/api/v1/nodes.kml`, or right-click the map legend's **KML** link and copy its address.
3. On the **Refresh** tab, set **Time-Based Refresh** to **Periodically**, about one polling cycle (for example every 10 minutes).
4. Click **OK**. Expand the folders in **Places** to show or hide bands and link types.

The KML uses Google's built-in map icons, so it also works if you download the file and open it offline.

The meshinfo API always sends the KML content type. **rsync-fed (legacy) hosts:** copy the whole `current/` snapshot (`rsync -aL`), so `nodes.kml`, `nodes.csv` and `nodes.json` arrive alongside `map_data.json`. Web servers usually send `.kml` as `application/vnd.google-earth.kml+xml`. If yours doesn't, add that type (for example `AddType application/vnd.google-earth.kml+xml .kml` in Apache). Google Earth Pro loads the file either way.

```bash
curl -sI http://localhost/meshmap/data/nodes.kml | grep -i content-type
```

#### Documentation Page
```
GET /meshmap/readme.html
```
Serves the project README rendered as an interactive HTML page with navigation links and GitHub-style formatting.

#### Web Interface
```
GET /meshmap/
```
Interactive Leaflet map with layer controls, search, and node visualization.

```
GET /meshmap/node_report/
```
Interactive DataTables report page with node statistics, filtering, and export capabilities.

## License

GPLv3 or later

**Original PHP implementation**: KG6WXC (2016-2024)  
**Python backend rewrite**: AI7BQ 2025

## Support & Contribution

- GitHub Issues: https://github.com/AI7BQ/nodographer
- AREDN Mesh: https://www.arednmesh.org/
- Original Project: https://github.com/r1de/KG6WXC-meshmap