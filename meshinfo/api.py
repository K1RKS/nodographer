#!/usr/bin/env python3
"""
meshinfo read-only HTTP API.

Serves the last published snapshot (<dataDir>/current) written by the poller.
It never talks to the database or the mesh, so it keeps serving the last good
scan while the poller is scanning, restarting, or failing.

  GET /api/v1/map_data.json          map markers, links and poll stats
  GET /api/v1/node_report_data.json  node report table
  GET /api/v1/nodes.kml|csv|json     node exports
  GET /api/v1/manifest.json          snapshot id, timestamps, counts, file hashes
  GET /api/v1/status.json            scan state + current snapshot summary
  GET /healthz                       200 if a snapshot is published, else 503

File paths match the names in <dataDir>/current/, so a frontend can switch
between a local path and this API by changing only its base URL.
"""

import argparse
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Tuple

from aiohttp import web

from meshinfo_config import ConfigManager
from publisher import MANIFEST, SNAPSHOT_FILES, STATUS, current_snapshot_dir, read_json

API_PREFIX = '/api/v1'
SERVED_FILES = frozenset(SNAPSHOT_FILES + (MANIFEST,))
CONTENT_TYPES = {
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.kml': 'application/vnd.google-earth.kml+xml',
}
DATA_DIR_KEY = web.AppKey('data_dir', Path)
ORIGINS_KEY = web.AppKey('allow_origins', tuple)

logger = logging.getLogger('meshinfo.api')


def _age_sec(stamp: Optional[str]) -> Optional[int]:
    if not stamp:
        return None
    try:
        dt = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
    except ValueError:
        return None
    return max(int((datetime.now(timezone.utc) - dt).total_seconds()), 0)


def _json_response(payload: Any, status: int = 200, headers: Optional[Dict[str, str]] = None) -> web.Response:
    resp = web.json_response(payload, status=status, dumps=lambda o: json.dumps(o, indent=2))
    resp.headers['Cache-Control'] = 'no-store'
    if headers:
        resp.headers.update(headers)
    return resp


def _no_snapshot() -> web.Response:
    return _json_response({'error': 'no snapshot has been published yet'}, status=503,
                          headers={'Retry-After': '60'})


def _read_current(data_dir: Path, name: str) -> Optional[Tuple[Path, bytes]]:
    # Resolve current once per request; retry once if the snapshot was pruned
    # between resolving the link and opening the file.
    for _ in range(2):
        snap = current_snapshot_dir(data_dir)
        if snap is None:
            return None
        try:
            return snap, (snap / name).read_bytes()
        except FileNotFoundError:
            continue
    return None


async def serve_snapshot_file(request: web.Request) -> web.StreamResponse:
    name = request.match_info['name']
    if name == STATUS:
        return await serve_status(request)
    if name not in SERVED_FILES:
        raise web.HTTPNotFound()

    found = _read_current(request.app[DATA_DIR_KEY], name)
    if found is None:
        return _no_snapshot()
    snap, body = found

    etag = f'{snap.name}-{name}'
    headers = {
        'ETag': f'"{etag}"',
        'Cache-Control': 'no-cache',
        'X-Meshinfo-Snapshot': snap.name,
    }
    if request.if_none_match and any(e.value == etag for e in request.if_none_match):
        return web.Response(status=304, headers=headers)

    resp = web.Response(body=body, headers=headers,
                        content_type=CONTENT_TYPES.get(Path(name).suffix, 'application/octet-stream'),
                        charset='utf-8')
    resp.enable_compression()
    return resp


def _snapshot_summary(manifest: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not manifest:
        return None
    keys = ('snapshotId', 'schemaVersion', 'generatedAt', 'publishedAt', 'cycle', 'localnode',
            'nodeCount', 'mappableNodes', 'linkCount', 'pollingTimeSec')
    return {k: manifest.get(k) for k in keys if k in manifest}


async def serve_status(request: web.Request) -> web.Response:
    data_dir = request.app[DATA_DIR_KEY]
    status = read_json(data_dir / STATUS) or {'state': 'unknown'}
    snap = current_snapshot_dir(data_dir)
    manifest = read_json(snap / MANIFEST) if snap else None
    payload = dict(status)
    payload['snapshot'] = _snapshot_summary(manifest)
    payload['ageSec'] = _age_sec((manifest or {}).get('publishedAt'))
    return _json_response(payload)


async def healthz(request: web.Request) -> web.Response:
    snap = current_snapshot_dir(request.app[DATA_DIR_KEY])
    if snap is None:
        return _no_snapshot()
    manifest = read_json(snap / MANIFEST) or {}
    return _json_response({'ok': True, 'snapshot': snap.name,
                           'ageSec': _age_sec(manifest.get('publishedAt'))})


async def index(request: web.Request) -> web.Response:
    return _json_response({
        'service': 'meshinfo',
        'files': sorted(SERVED_FILES | {STATUS}),
        'prefix': API_PREFIX + '/',
    })


@web.middleware
async def cors_middleware(request: web.Request, handler) -> web.StreamResponse:
    allowed = request.app[ORIGINS_KEY]
    origin = request.headers.get('Origin')
    if request.method == 'OPTIONS':
        resp: web.StreamResponse = web.Response(status=204)
    else:
        try:
            resp = await handler(request)
        except web.HTTPException as exc:
            resp = exc
    if '*' in allowed:
        resp.headers['Access-Control-Allow-Origin'] = '*'
    elif origin and origin in allowed:
        resp.headers['Access-Control-Allow-Origin'] = origin
        resp.headers.add('Vary', 'Origin')
    if 'Access-Control-Allow-Origin' in resp.headers:
        resp.headers['Access-Control-Allow-Methods'] = 'GET, HEAD, OPTIONS'
        resp.headers['Access-Control-Allow-Headers'] = 'If-None-Match'
        resp.headers['Access-Control-Expose-Headers'] = 'ETag, X-Meshinfo-Snapshot'
        resp.headers['Access-Control-Max-Age'] = '86400'
    if isinstance(resp, web.HTTPException):
        raise resp
    return resp


def create_app(data_dir, allow_origins: Iterable[str] = ('*',)) -> web.Application:
    app = web.Application(middlewares=[cors_middleware])
    app[DATA_DIR_KEY] = Path(data_dir)
    app[ORIGINS_KEY] = tuple(allow_origins)
    app.router.add_get('/healthz', healthz)
    app.router.add_get(API_PREFIX + '/', index)
    app.router.add_get(API_PREFIX + '/{name}', serve_snapshot_file)
    app.router.add_route('OPTIONS', API_PREFIX + '/{name}', serve_snapshot_file)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description='meshinfo read-only data API')
    parser.add_argument('--config', default=None,
                        help='Path to meshinfo.toml (default: next to this script)')
    parser.add_argument('--listen', default=None, help='Override [api] listen address')
    parser.add_argument('--port', type=int, default=None, help='Override [api] port')
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                        format='%(levelname)s: %(name)s: %(message)s')
    config = ConfigManager(args.config)
    host = args.listen or config.get('api', 'listen', '0.0.0.0')
    port = args.port or config.getint('api', 'port', 8090)
    origins = config.get('api', 'allowOrigins', ['*'])
    if isinstance(origins, str):
        origins = [origins]

    logger.info(f"Serving {config.data_dir}/current on http://{host}:{port}{API_PREFIX}/")
    web.run_app(create_app(config.data_dir, origins), host=host, port=port,
                print=None, access_log=None)


if __name__ == '__main__':
    main()
