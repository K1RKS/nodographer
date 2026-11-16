#!/usr/bin/env python3
"""
meshinfo HTTP API.

Serves the last published snapshot (<dataDir>/current) written by the poller.
Snapshot GETs never talk to the database or the mesh, so the last good scan
stays available while the poller is scanning, restarting, or failing.

When [api] enableTraceProxy is true, POST /api/v1/trace proxies traceroute /
stableroute requests to a source node found in the current snapshot (SSRF-safe).

  GET  /api/v1/map_data.json          map markers, links and poll stats
  GET  /api/v1/node_report_data.json  node report table
  GET  /api/v1/nodes.kml|csv|json     node exports
  GET  /api/v1/manifest.json          snapshot id, timestamps, counts, file hashes
  GET  /api/v1/status.json            scan state + current snapshot summary
  POST /api/v1/trace                  live traceroute/stableroute proxy (opt-in)
  GET  /healthz                       200 if a snapshot is published, else 503

File paths match the names in <dataDir>/current/, so a frontend can switch
between a local path and this API by changing only its base URL.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Tuple

from aiohttp import web

from meshinfo_config import ConfigManager
from publisher import MANIFEST, SNAPSHOT_FILES, STATUS, current_snapshot_dir, read_json
from trace_proxy import (
    DATA_DIR_KEY as TRACE_DATA_DIR_KEY,
    TRACE_CFG_KEY,
    TRACE_SEM_KEY,
    handle_trace,
)

API_PREFIX = '/api/v1'
SERVED_FILES = frozenset(SNAPSHOT_FILES + (MANIFEST,))
CONTENT_TYPES = {
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.kml': 'application/vnd.google-earth.kml+xml',
}
DATA_DIR_KEY = TRACE_DATA_DIR_KEY
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
    cfg = request.app.get(TRACE_CFG_KEY) or {}
    payload['traceProxy'] = bool(cfg.get('enabled'))
    return _json_response(payload)


async def healthz(request: web.Request) -> web.Response:
    snap = current_snapshot_dir(request.app[DATA_DIR_KEY])
    if snap is None:
        return _no_snapshot()
    manifest = read_json(snap / MANIFEST) or {}
    return _json_response({'ok': True, 'snapshot': snap.name,
                           'ageSec': _age_sec(manifest.get('publishedAt'))})


async def index(request: web.Request) -> web.Response:
    cfg = request.app.get(TRACE_CFG_KEY) or {}
    return _json_response({
        'service': 'meshinfo',
        'files': sorted(SERVED_FILES | {STATUS}),
        'prefix': API_PREFIX + '/',
        'traceProxy': bool(cfg.get('enabled')),
        'traceEndpoint': API_PREFIX + '/trace' if cfg.get('enabled') else None,
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
        methods = 'GET, HEAD, OPTIONS'
        headers = 'If-None-Match'
        cfg = request.app.get(TRACE_CFG_KEY) or {}
        if cfg.get('enabled'):
            methods = 'GET, HEAD, POST, OPTIONS'
            headers = 'If-None-Match, Content-Type'
        resp.headers['Access-Control-Allow-Methods'] = methods
        resp.headers['Access-Control-Allow-Headers'] = headers
        resp.headers['Access-Control-Expose-Headers'] = 'ETag, X-Meshinfo-Snapshot'
        resp.headers['Access-Control-Max-Age'] = '86400'
    if isinstance(resp, web.HTTPException):
        raise resp
    return resp


def _truthy(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() in ('1', 'true', 'yes', 'on')


def create_app(
    data_dir,
    allow_origins: Iterable[str] = ('*',),
    trace_cfg: Optional[Dict[str, Any]] = None,
) -> web.Application:
    app = web.Application(middlewares=[cors_middleware])
    app[DATA_DIR_KEY] = Path(data_dir)
    app[ORIGINS_KEY] = tuple(allow_origins)
    cfg = dict(trace_cfg or {})
    cfg.setdefault('enabled', False)
    cfg.setdefault('traceTimeoutSec', 120)
    cfg.setdefault('stablerouteTimeoutSec', 120)
    cfg.setdefault('stablerouteMaxN', 20)
    cfg.setdefault('traceMaxConcurrent', 2)
    app[TRACE_CFG_KEY] = cfg
    app[TRACE_SEM_KEY] = asyncio.Semaphore(int(cfg.get('traceMaxConcurrent') or 2))

    app.router.add_get('/healthz', healthz)
    app.router.add_get(API_PREFIX + '/', index)
    app.router.add_post(API_PREFIX + '/trace', handle_trace)
    app.router.add_route('OPTIONS', API_PREFIX + '/trace', handle_trace)
    app.router.add_get(API_PREFIX + '/{name}', serve_snapshot_file)
    app.router.add_route('OPTIONS', API_PREFIX + '/{name}', serve_snapshot_file)
    return app


def _trace_cfg_from_config(config: ConfigManager) -> Dict[str, Any]:
    return {
        'enabled': _truthy(config.get('api', 'enableTraceProxy', False)),
        'traceTimeoutSec': config.getfloat('api', 'traceTimeoutSec', 120.0),
        'stablerouteTimeoutSec': config.getfloat('api', 'stablerouteTimeoutSec', 120.0),
        'stablerouteMaxN': config.getint('api', 'stablerouteMaxN', 20),
        'traceMaxConcurrent': config.getint('api', 'traceMaxConcurrent', 2),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description='meshinfo data API')
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
    trace_cfg = _trace_cfg_from_config(config)

    logger.info(
        'Serving %s/current on http://%s:%d%s/ (traceProxy=%s)',
        config.data_dir, host, port, API_PREFIX, trace_cfg['enabled'],
    )
    web.run_app(
        create_app(config.data_dir, origins, trace_cfg=trace_cfg),
        host=host,
        port=port,
        print=None,
        access_log=None,
    )


if __name__ == '__main__':
    main()
