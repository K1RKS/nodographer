#!/usr/bin/env python3
"""
Interactive setup for an installed Nodographer.

Edits meshinfo/meshinfo.toml and/or frontend/config/nodographer.json, showing
the current values as defaults, then applies the changes (restarts the
meshinfo services; the frontend only needs a browser reload).

Run it through setup.sh as the user that owns those files (lxc-install.sh
creates that user), or as root.
"""

import argparse
import json
import os
import pwd
import re
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    import tomllib
except ImportError:  # Python < 3.11; the meshinfo venv has tomli
    import tomli as tomllib

REPO = Path(__file__).resolve().parents[1]
MESHINFO_CONFIG = REPO / 'meshinfo' / 'meshinfo.toml'
FRONTEND_CONFIG = REPO / 'frontend' / 'config' / 'nodographer.json'
FRONTEND_INSTALL = REPO / 'frontend' / 'INSTALL.sh'
MESHINFO_UNITS = ['meshinfo-poller.service', 'meshinfo-api.service']
# Must match the command allowed in /etc/sudoers.d/nodographer
RESTART_CMD = ['/usr/bin/systemctl', 'restart', *MESHINFO_UNITS]
WEB_LINK = Path('/var/www/html/meshmap')

TILE_PRESETS = [
    ('inet.Street', '//{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
     'OpenStreetMap street map (internet)'),
    ('inet.Topographic', '//{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
     'OpenTopoMap topographic map (internet)'),
]


# ----- prompts -----

def header(title: str) -> None:
    print(f'\n=== {title} ===\n')


def ask(prompt: str, default: Any = '') -> str:
    default = '' if default is None else str(default)
    suffix = f' [{default}]' if default else ''
    try:
        reply = input(f'{prompt}{suffix}: ').strip()
    except EOFError:
        print()
        reply = ''
    return reply or default


def ask_optional(prompt: str, default: Any = '') -> str:
    """Like ask(), but '-' clears the value."""
    reply = ask(f'{prompt} (- to clear)', default)
    return '' if reply == '-' else reply


def ask_int(prompt: str, default: int, lo: int, hi: int) -> int:
    while True:
        reply = ask(prompt, default)
        try:
            value = int(reply)
        except ValueError:
            print(f'  Enter a whole number from {lo} to {hi}.')
            continue
        if lo <= value <= hi:
            return value
        print(f'  Enter a whole number from {lo} to {hi}.')


def ask_float(prompt: str, default: float, lo: float, hi: float) -> float:
    while True:
        reply = ask(prompt, default)
        try:
            value = float(reply)
        except ValueError:
            print(f'  Enter a number from {lo} to {hi}.')
            continue
        if lo <= value <= hi:
            return value
        print(f'  Enter a number from {lo} to {hi}.')


def ask_bool(prompt: str, default: bool) -> bool:
    while True:
        reply = ask(f'{prompt} (y/n)', 'y' if default else 'n').lower()
        if reply in ('y', 'yes'):
            return True
        if reply in ('n', 'no'):
            return False
        print('  Answer y or n.')


def ask_choice(prompt: str, options: List[Tuple[str, str]], default: str) -> str:
    for i, (key, label) in enumerate(options, 1):
        print(f'  {i}) {key:<10} {label}')
    keys = [key for key, _ in options]
    while True:
        reply = ask(prompt, keys.index(default) + 1 if default in keys else '')
        if reply.isdigit() and 1 <= int(reply) <= len(options):
            return keys[int(reply) - 1]
        if reply in keys:
            return reply
        print(f'  Choose 1-{len(options)}.')


# ----- TOML editing (keeps comments and layout) -----

def toml_literal(value: Any) -> str:
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return '[' + ', '.join(toml_literal(v) for v in value) + ']'
    raise TypeError(f'Unsupported TOML value: {value!r}')


def set_toml(text: str, section: str, key: str, value: Any) -> str:
    """Set section.key on a single line, adding the key or section if missing."""
    lines = text.splitlines()
    header_re = re.compile(r'^\s*\[([^\[\]]+)\]\s*(#.*)?$')
    start, end = None, len(lines)
    for i, line in enumerate(lines):
        m = header_re.match(line)
        if not m:
            continue
        if start is not None:
            end = i
            break
        if m.group(1).strip() == section:
            start = i
    new_line = f'{key} = {toml_literal(value)}'
    if start is None:
        lines += ['', f'[{section}]', new_line]
    else:
        key_re = re.compile(r'^\s*' + re.escape(key) + r'\s*=')
        for i in range(start + 1, end):
            if key_re.match(lines[i]):
                lines[i] = new_line
                break
        else:
            j = end
            while j > start + 1 and not lines[j - 1].strip():
                j -= 1
            lines.insert(j, new_line)
    return '\n'.join(lines) + '\n'


# ----- helpers -----

def fetch_json(url: str, timeout: float = 15) -> Any:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.load(resp)


def check_node(node: str) -> Tuple[bool, str]:
    try:
        data = fetch_json(f'http://{node}/cgi-bin/sysinfo.json?nodes=1')
    except Exception as e:
        return False, str(e)
    if not isinstance(data, dict):
        return True, node
    nodes = data.get('nodes')
    name = data.get('node') or node
    return True, f'{name}, which lists {len(nodes)} nodes' if isinstance(nodes, list) else name


def check_meshinfo_api(base_url: str) -> Tuple[bool, str]:
    try:
        data = fetch_json(base_url + 'status.json', timeout=10)
    except Exception as e:
        return False, str(e)
    snap = data.get('snapshot') or {}
    return True, (f"state {data.get('state')}, snapshot {data.get('currentSnapshot')}, "
                  f"{snap.get('nodeCount', '?')} nodes")


def system_timezone() -> str:
    try:
        return Path('/etc/timezone').read_text().strip()
    except OSError:
        pass
    try:
        target = os.readlink('/etc/localtime')
        return target.split('zoneinfo/', 1)[1]
    except (OSError, IndexError):
        return 'UTC'


def valid_timezone(name: str) -> bool:
    try:
        from zoneinfo import ZoneInfo
        ZoneInfo(name)
        return True
    except Exception:
        return False


def owner_name(path: Path) -> str:
    try:
        return pwd.getpwuid(path.stat().st_uid).pw_name
    except KeyError:
        return str(path.stat().st_uid)


def run_as_root(cmd: List[str], sudo_flags: Optional[List[str]] = None) -> bool:
    if os.geteuid() != 0:
        cmd = ['sudo', *(sudo_flags or []), *cmd]
    return subprocess.run(cmd).returncode == 0


def show_changes(changes: List[Tuple[str, Any, Any]]) -> None:
    print('\nChanges:')
    for name, old, new in changes:
        print(f'  {name}: {old!r} -> {new!r}')
    print()


# ----- meshinfo -----

def setup_meshinfo() -> None:
    header('meshinfo: scanner and data API')
    text = MESHINFO_CONFIG.read_text(encoding='utf-8')
    cfg = tomllib.loads(text)
    changes: List[Tuple[str, str, Any, Any]] = []

    def get(section: str, key: str, default: Any) -> Any:
        return cfg.get(section, {}).get(key, default)

    def update(section: str, key: str, value: Any) -> None:
        old = get(section, key, None)
        if old != value:
            changes.append((section, key, old, value))

    print('The scanner reads the list of mesh nodes from one AREDN node. Use a node')
    print('this host can reach, for example localnode.local.mesh when it sits behind')
    print('a mesh node and uses its DNS, or a node name or 10.x address.\n')
    while True:
        node = ask('Topology node (nodelistNode)', get('polling', 'nodelistNode', 'localnode.local.mesh'))
        ok, info = check_node(node)
        if ok:
            print(f'  OK: reached {info}')
            break
        print(f'  Could not reach http://{node}/cgi-bin/sysinfo.json ({info})')
        if ask_bool('Use it anyway?', False):
            break
    update('polling', 'nodelistNode', node)

    while True:
        tz = ask('Time zone (localTimeZone)', get('polling', 'localTimeZone', system_timezone()))
        if valid_timezone(tz):
            break
        print('  Unknown time zone; use a name like America/Los_Angeles or UTC.')
    update('polling', 'localTimeZone', tz)

    update('polling', 'pollerCycleTime',
           ask_int('Minutes between scans (pollerCycleTime)', get('polling', 'pollerCycleTime', 15), 1, 1440))
    update('polling', 'numParallelThreads',
           ask_int('Nodes polled at once (numParallelThreads)', get('polling', 'numParallelThreads', 500), 1, 2000))
    update('hops', 'enableHopCount',
           ask_bool('Measure hop counts with traceroute (enableHopCount)', get('hops', 'enableHopCount', True)))
    update('retention', 'expireInterval',
           ask_int('Days to keep a node that stops answering (expireInterval)',
                   get('retention', 'expireInterval', 30), 1, 3650))
    update('publish', 'exportTitle',
           ask('Document name in nodes.kml / Google Earth (exportTitle)',
               get('publish', 'exportTitle', 'Nodographer Mesh Map')))

    print('\nBrowsers on other sites may read this API only if their origin is allowed.')
    print('"*" allows any site, which is fine for public read-only mesh data.')
    origins = ask('Allowed origins, comma-separated (allowOrigins)', ', '.join(get('api', 'allowOrigins', ['*'])))
    update('api', 'allowOrigins', [o.strip() for o in origins.split(',') if o.strip()] or ['*'])

    if not changes:
        print('\nNo changes to meshinfo.')
        return
    show_changes([(f'[{s}] {k}', old, new) for s, k, old, new in changes])
    if not ask_bool('Save and restart meshinfo?', True):
        print('Not saved.')
        return
    for section, key, _, value in changes:
        text = set_toml(text, section, key, value)
    tomllib.loads(text)
    MESHINFO_CONFIG.write_text(text, encoding='utf-8')
    print(f'Saved {MESHINFO_CONFIG}')

    if run_as_root(RESTART_CMD, ['-n']):
        print('Restarted ' + ' and '.join(MESHINFO_UNITS) + '.')
        print('The API keeps serving the last snapshot until the next scan finishes.')
        print('Follow the scan: journalctl -fu meshinfo-poller.service')
    else:
        print('Could not restart the services. As root, run:')
        print('  systemctl restart ' + ' '.join(MESHINFO_UNITS))


# ----- frontend -----

def edit_tile_servers(m: Dict[str, Any]) -> None:
    servers: Dict[str, str] = dict(m.get('tileServers') or {})
    priority = [n for n in (m.get('priority') or []) if n in servers]
    order = priority + [n for n in servers if n not in priority]
    default = m.get('defaultTileServer')
    if default not in servers:
        default = order[0] if order else None

    print('\nTile servers are the background maps in the layer menu. Mesh tile servers')
    print('(*.local.mesh) only load for browsers on the mesh; internet ones need internet.')

    def pick(prompt: str) -> Optional[int]:
        reply = ask(prompt, '')
        if reply.isdigit() and 1 <= int(reply) <= len(order):
            return int(reply) - 1
        print('  No such number.')
        return None

    def ask_url(default: str = '') -> Optional[str]:
        url = ask('Tile URL with {z}, {x} and {y}', default)
        if all(p in url for p in ('{z}', '{x}', '{y}')):
            return url
        print('  The URL must contain {z}, {x} and {y}, '
              'for example //tiles.example.local.mesh/osm/{z}/{x}/{y}.png')
        return None

    while True:
        print('\nTile servers (layer menu order):')
        if not order:
            print('  (none)')
        for i, name in enumerate(order, 1):
            mark = '  (default)' if name == default else ''
            print(f'  {i}) {name}{mark}\n       {servers[name]}')
        print('\n  a) add   r) remove   u) move up   d) set default   e) edit URL   Enter) done')
        choice = ask('Choice', '').lower()
        if choice == '':
            if order:
                break
            print('  The map needs at least one tile server.')
            continue
        if choice == 'a':
            presets = [p for p in TILE_PRESETS if p[0] not in servers]
            for i, (name, _, label) in enumerate(presets, 1):
                print(f'  {i}) {name:<18} {label}')
            print('  c) custom, for example a mesh tile server')
            reply = ask('Add', 'c').lower()
            if reply.isdigit() and 1 <= int(reply) <= len(presets):
                name, url, _ = presets[int(reply) - 1]
            elif reply == 'c':
                name = ask('Name shown in the layer menu (e.g. aredn.MYCALL or inet.Satellite)', '')
                if not name or name in servers:
                    print('  The name must be new and not empty.')
                    continue
                url = ask_url()
                if not url:
                    continue
            else:
                continue
            servers[name] = url
            order.append(name)
            if default is None:
                default = name
        elif choice == 'r' and order:
            i = pick('Remove number')
            if i is not None:
                name = order.pop(i)
                del servers[name]
                if default == name:
                    default = order[0] if order else None
        elif choice == 'u' and order:
            i = pick('Move up number')
            if i:
                order[i - 1], order[i] = order[i], order[i - 1]
        elif choice == 'd' and order:
            i = pick('Default number')
            if i is not None:
                default = order[i]
        elif choice == 'e' and order:
            i = pick('Edit number')
            if i is not None:
                url = ask_url(servers[order[i]])
                if url:
                    servers[order[i]] = url

    m['tileServers'] = {name: servers[name] for name in order}
    m['priority'] = order
    m['defaultTileServer'] = default


def change_data_source() -> None:
    options = []
    if MESHINFO_CONFIG.exists():
        options.append(('local', 'meshinfo on this host'))
    options += [
        ('proxy', 'remote meshinfo API, proxied through this nginx (best for HTTPS sites)'),
        ('direct', "remote meshinfo API, fetched by the browser (needs CORS, and TLS if this site uses it)"),
        ('legacy', 'JSON files copied into frontend/data/ by rsync'),
    ]
    mode = ask_choice('Data source', options, options[0][0])
    args = [str(FRONTEND_INSTALL), '-y', '--mode', mode]
    if mode in ('proxy', 'direct'):
        while True:
            url = ask('meshinfo API URL (e.g. http://meshinfo-host:8090/api/v1/)', '')
            if not url:
                continue
            if not url.endswith('/'):
                url += '/'
            ok, info = check_meshinfo_api(url)
            if ok:
                print(f'  OK: {info}')
                break
            print(f'  Could not read {url}status.json ({info})')
            if ask_bool('Use it anyway?', False):
                break
        args += ['--meshinfo-url', url]
    if not WEB_LINK.is_symlink():
        args.append('--no-web-server')
    print('\nChanging the data source needs root (nginx and symlinks).')
    if not run_as_root(args):
        print('That did not complete. As root, run:')
        print('  ' + ' '.join(args))


def setup_frontend() -> None:
    header('Frontend: the map')
    cfg = json.loads(FRONTEND_CONFIG.read_text(encoding='utf-8'))
    before = json.dumps(cfg, sort_keys=True)
    m = cfg.setdefault('map', {})

    m['title'] = ask('Map title (browser tab)', m.get('title', 'Nodographer Mesh Map'))
    print('\nWhere the map opens. Get coordinates by right-clicking a spot in most online maps.')
    m['centerLat'] = ask_float('Center latitude', m.get('centerLat', 0.0), -90, 90)
    m['centerLon'] = ask_float('Center longitude', m.get('centerLon', 0.0), -180, 180)
    m['initialZoom'] = ask_int('Initial zoom (1 = world, 7 = a state, 12 = a city)',
                               m.get('initialZoom', 7), 1, 19)
    m['distanceUnits'] = ask_choice('Distance units', [('miles', ''), ('kilometers', '')],
                                    m.get('distanceUnits', 'miles'))
    m['contact'] = ask_optional('Contact (e.g. an email address)', m.get('contact', ''))
    m['attribution'] = ask('Map attribution', m.get('attribution', '© OpenStreetMap contributors'))
    m['reportBrowserTitle'] = ask('Node report browser tab title',
                                  m.get('reportBrowserTitle', 'Nodographer Node Report'))
    m['reportPageTitle'] = ask('Node report page heading', m.get('reportPageTitle', 'Node Report'))
    m['geocoderUrl'] = ask_optional('Address search (geocoder) URL, blank for the built-in default',
                                    m.get('geocoderUrl', ''))

    edit_tile_servers(m)

    if json.dumps(cfg, sort_keys=True) != before:
        if ask_bool('\nSave the map settings?', True):
            FRONTEND_CONFIG.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
            print(f'Saved {FRONTEND_CONFIG}. Reload the map in your browser to see the changes.')
        else:
            print('Not saved.')
    else:
        print('\nNo changes to the map settings.')

    base = (cfg.get('meshinfo') or {}).get('baseUrl', 'data/')
    print(f'\nThe map reads its mesh data from: {base}')
    if ask_bool('Change where the map gets its data?', False):
        change_data_source()


# ----- main -----

def main() -> int:
    parser = argparse.ArgumentParser(description='Configure an installed Nodographer.')
    parser.add_argument('--meshinfo', action='store_true', help='Only configure meshinfo')
    parser.add_argument('--frontend', action='store_true', help='Only configure the frontend')
    args = parser.parse_args()

    installed = {
        'meshinfo': MESHINFO_CONFIG.exists(),
        'frontend': FRONTEND_CONFIG.exists(),
    }
    if not any(installed.values()):
        print('Nothing to configure yet: install Nodographer first (lxc-install.sh or INSTALL.sh).')
        return 1

    wanted = [name for name in ('meshinfo', 'frontend') if getattr(args, name)]
    for name in wanted:
        if not installed[name]:
            print(f'{name} is not installed on this host.')
            return 1
    if not wanted:
        present = [name for name, ok in installed.items() if ok]
        if len(present) == 2:
            choice = ask_choice('Configure', [('both', 'meshinfo and the map'),
                                              ('meshinfo', 'scanner and data API'),
                                              ('frontend', 'the map')], 'both')
            wanted = present if choice == 'both' else [choice]
        else:
            wanted = present

    paths = {'meshinfo': MESHINFO_CONFIG, 'frontend': FRONTEND_CONFIG}
    for name in wanted:
        if not os.access(paths[name], os.W_OK):
            print(f'{paths[name]} belongs to {owner_name(paths[name])}. '
                  'Run this as that user, or with sudo.')
            return 1

    if 'meshinfo' in wanted:
        setup_meshinfo()
    if 'frontend' in wanted:
        setup_frontend()
    print('\nDone. Run this again any time to change settings.')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('\nCancelled. Settings already saved stay saved.')
        sys.exit(130)
