#!/usr/bin/env python3
"""
Split a legacy Nodographer settings.toml into:

  meshinfo/meshinfo.toml            scanner settings (database, polling, hops,
                                    retention) plus [publish] and [api]
  frontend/config/nodographer.json  map presentation settings (tile servers,
                                    center, zoom, titles, units) and the
                                    meshinfo data source

Existing output files are left alone unless --force is given.

Usage:
  meshinfo/tools/migrate_settings.py
  meshinfo/tools/migrate_settings.py --settings /srv/meshmap/settings.toml \\
      --data-dir /var/lib/meshinfo --base-url meshinfo/current/
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

try:
    import tomllib
except ImportError:  # Python < 3.11
    import tomli as tomllib

REPO = Path(__file__).resolve().parents[2]
MESHINFO_SECTIONS = ('database', 'polling', 'hops', 'retention')


def toml_value(value: Any) -> str:
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return '[' + ', '.join(toml_value(v) for v in value) + ']'
    raise TypeError(f'unsupported TOML value: {value!r}')


def toml_dump(sections: Dict[str, Dict[str, Any]], header: str) -> str:
    out: List[str] = [header.rstrip(), '']
    for name, values in sections.items():
        out.append(f'[{name}]')
        for key, value in values.items():
            if isinstance(value, dict):
                continue
            out.append(f'{key} = {toml_value(value)}')
        out.append('')
    return '\n'.join(out)


def flatten_tileservers(section: Dict[str, Any]) -> Dict[str, str]:
    servers: Dict[str, str] = {}

    def walk(prefix: str, obj: Any) -> None:
        if isinstance(obj, dict):
            for k, v in obj.items():
                walk(f'{prefix}.{k}' if prefix else str(k), v)
        elif isinstance(obj, str):
            servers[prefix] = obj

    for key, value in section.items():
        if key != 'priority':
            walk(key, value)
    return servers


def build_meshinfo(settings: Dict[str, Any], data_dir: str) -> Dict[str, Dict[str, Any]]:
    sections = {name: dict(settings.get(name, {})) for name in MESHINFO_SECTIONS}
    publish = dict(settings.get('publish', {}))
    publish.setdefault('dataDir', data_dir)
    publish.setdefault('keepSnapshots', 3)
    publish.setdefault('minNodeRatio', 0.5)
    publish.setdefault('exportTitle', settings.get('map', {}).get('browserTitle', 'Nodographer Mesh Map'))
    sections['publish'] = publish
    api = dict(settings.get('api', {}))
    api.setdefault('listen', '0.0.0.0')
    api.setdefault('port', 8090)
    api.setdefault('allowOrigins', ['*'])
    sections['api'] = api
    return sections


def build_frontend(settings: Dict[str, Any], base_url: str) -> Dict[str, Any]:
    m = settings.get('map', {})
    attribution = settings.get('attribution', {})
    tiles = settings.get('tileservers', {})
    map_cfg: Dict[str, Any] = {}

    def put(key: str, value: Any) -> None:
        if value is not None:
            map_cfg[key] = value

    put('title', m.get('browserTitle'))
    for src, dest in (('center_lat', 'centerLat'), ('center_lon', 'centerLon')):
        if m.get(src) is not None:
            map_cfg[dest] = float(m[src])
    if m.get('initial_zoom_level') is not None:
        map_cfg['initialZoom'] = int(m['initial_zoom_level'])
    put('distanceUnits', m.get('distanceUnits'))
    put('contact', m.get('contact'))
    put('attribution', attribution.get('credit'))
    put('reportBrowserTitle', attribution.get('browserTitle'))
    put('reportPageTitle', attribution.get('pageTitle'))
    servers = flatten_tileservers(tiles) if isinstance(tiles, dict) else {}
    if servers:
        map_cfg['tileServers'] = servers
    priority = tiles.get('priority') if isinstance(tiles, dict) else None
    if isinstance(priority, list) and priority:
        map_cfg['priority'] = priority
    return {'meshinfo': {'baseUrl': base_url}, 'map': map_cfg}


def write(path: Path, text: str, force: bool) -> bool:
    if path.exists() and not force:
        print(f'skip   {path} (exists; use --force to overwrite)')
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')
    print(f'wrote  {path}')
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--settings', default=str(REPO / 'settings.toml'), help='legacy settings.toml')
    parser.add_argument('--meshinfo-out', default=str(REPO / 'meshinfo' / 'meshinfo.toml'))
    parser.add_argument('--frontend-out', default=str(REPO / 'frontend' / 'config' / 'nodographer.json'))
    parser.add_argument('--data-dir', default='/var/lib/meshinfo', help='[publish] dataDir')
    parser.add_argument('--base-url', default='meshinfo/current/', help='frontend meshinfo.baseUrl')
    parser.add_argument('--only', choices=('meshinfo', 'frontend'), help='write just one of the files')
    parser.add_argument('--force', action='store_true', help='overwrite existing output files')
    args = parser.parse_args()

    settings_path = Path(args.settings)
    if not settings_path.exists():
        print(f'error: {settings_path} not found', file=sys.stderr)
        return 1
    with open(settings_path, 'rb') as f:
        settings = tomllib.load(f)

    if args.only in (None, 'meshinfo'):
        header = (f'# meshinfo configuration, migrated from {settings_path}\n'
                  '# See meshinfo.example.toml for documentation of every setting.')
        write(Path(args.meshinfo_out), toml_dump(build_meshinfo(settings, args.data_dir), header), args.force)
    if args.only in (None, 'frontend'):
        doc = build_frontend(settings, args.base_url)
        write(Path(args.frontend_out), json.dumps(doc, indent=2, ensure_ascii=False) + '\n', args.force)
    return 0


if __name__ == '__main__':
    sys.exit(main())
