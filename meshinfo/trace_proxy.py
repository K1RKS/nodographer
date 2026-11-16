"""
Opt-in meshinfo live traceroute / stableroute proxy.

Resolves the source node from the current snapshot (SSRF guard), fetches the
node CGI with format=json when available, and normalizes the response to
schemaVersion-1 JSON for the Nodographer visual traceroute overlay.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from urllib.parse import quote, urlencode

from aiohttp import ClientSession, ClientTimeout, web

from publisher import current_snapshot_dir
from trace_parse import coerce_trace_document, node_key

logger = logging.getLogger('meshinfo.trace')

TRACE_CFG_KEY = web.AppKey('trace_cfg', dict)
TRACE_SEM_KEY = web.AppKey('trace_sem', asyncio.Semaphore)
DATA_DIR_KEY = web.AppKey('data_dir', Path)
SAFE_NAME_RE = re.compile(r'^[0-9a-zA-Z.\-]+$')


def load_node_index(data_dir: Path) -> Dict[str, str]:
    """Map lowercase short hostname and wlan_ip -> mesh IP from current snapshot."""
    snap = current_snapshot_dir(data_dir)
    if snap is None:
        return {}
    index: Dict[str, str] = {}

    def add(name: Optional[str], ip: Optional[str]) -> None:
        if not ip or not re.match(r'^\d{1,3}(?:\.\d{1,3}){3}$', str(ip)):
            return
        ip = str(ip)
        index[ip] = ip
        key = node_key(name)
        if key:
            index[key] = ip
            index[f'{key}.local.mesh'] = ip

    map_path = snap / 'map_data.json'
    if map_path.exists():
        try:
            data = json.loads(map_path.read_text(encoding='utf-8'))
            devices = (data or {}).get('allDevices') or {}
            if isinstance(devices, dict):
                for band_nodes in devices.values():
                    if not isinstance(band_nodes, list):
                        continue
                    for node in band_nodes:
                        if not isinstance(node, dict):
                            continue
                        add(node.get('node'), node.get('wlan_ip'))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning('failed to index map_data.json: %s', exc)

    nodes_path = snap / 'nodes.json'
    if nodes_path.exists():
        try:
            data = json.loads(nodes_path.read_text(encoding='utf-8'))
            nodes = data.get('nodes') if isinstance(data, dict) else data
            if isinstance(nodes, list):
                for node in nodes:
                    if not isinstance(node, dict):
                        continue
                    add(node.get('node') or node.get('name'), node.get('wlan_ip') or node.get('ip'))
            elif isinstance(nodes, dict):
                for name, node in nodes.items():
                    if isinstance(node, dict):
                        add(node.get('node') or name, node.get('wlan_ip') or node.get('ip'))
                    elif isinstance(node, str):
                        add(name, node)
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning('failed to index nodes.json: %s', exc)

    return index


def resolve_source_ip(index: Dict[str, str], source: str) -> Optional[str]:
    if not source:
        return None
    raw = source.strip()
    if raw in index:
        return index[raw]
    key = node_key(raw)
    if key in index:
        return index[key]
    dotted = f'{key}.local.mesh'
    if dotted in index:
        return index[dotted]
    return None


def build_node_url(
    tool: str,
    source_ip: str,
    destination: str,
    n: int,
    legacy: bool,
    *,
    want_json: bool = True,
) -> str:
    qs: Dict[str, str] = {'server': destination}
    if want_json:
        qs['format'] = 'json'
    if tool == 'stableroute':
        qs['n'] = str(n)
        if legacy:
            qs['legacy'] = '1'
        path = 'stableroute'
    else:
        path = 'traceroute'
    return f'http://{source_ip}/cgi-bin/{path}?{urlencode(qs, quote_via=quote)}'


async def fetch_node_trace(
    session: ClientSession,
    url: str,
    tool: str,
    destination: str,
) -> Tuple[Dict[str, Any], str]:
    async with session.get(url) as resp:
        body = await resp.read()
        ctype = (resp.headers.get('Content-Type') or '').lower()
        text = body.decode('utf-8', errors='replace')
        if resp.status >= 400:
            raise web.HTTPBadGateway(
                text=json.dumps({
                    'error': f'node CGI returned HTTP {resp.status}',
                    'body': text[:500],
                }),
                content_type='application/json',
            )
        # Some stableroute builds returned Content-Type JSON with an empty body.
        if not text.strip():
            raise RuntimeError('node CGI returned empty body')
        via = 'json' if ('json' in ctype or text.lstrip().startswith('{')) else 'text'
        doc = coerce_trace_document(text, tool, destination)
        # Empty JSON path lists are not useful — caller may retry text CGI.
        if via == 'json' and tool == 'stableroute' and not (doc.get('paths') or []):
            raise RuntimeError('stableroute JSON had no paths')
        return doc, via


async def handle_trace(request: web.Request) -> web.Response:
    cfg = request.app.get(TRACE_CFG_KEY) or {}
    if not cfg.get('enabled'):
        return web.json_response(
            {'error': 'trace proxy disabled (set [api] enableTraceProxy = true)'},
            status=403,
        )

    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({'error': 'invalid JSON body'}, status=400)
    if not isinstance(body, dict):
        return web.json_response({'error': 'JSON object required'}, status=400)

    tool = str(body.get('tool') or 'traceroute').strip().lower()
    if tool in ('aredn-traceroute', 'trace'):
        tool = 'traceroute'
    if tool not in ('traceroute', 'stableroute'):
        return web.json_response({'error': 'tool must be traceroute or stableroute'}, status=400)

    source = str(body.get('source') or '').strip()
    destination = str(body.get('destination') or body.get('server') or '').strip()
    if not source or not destination:
        return web.json_response({'error': 'source and destination are required'}, status=400)
    if not SAFE_NAME_RE.match(source) or not SAFE_NAME_RE.match(destination):
        return web.json_response({'error': 'illegal source or destination name'}, status=400)

    max_n = int(cfg.get('stablerouteMaxN') or 20)
    try:
        n = int(body.get('n') or 10)
    except (TypeError, ValueError):
        return web.json_response({'error': 'n must be an integer'}, status=400)
    if n < 1 or n > max_n:
        return web.json_response({'error': f'n must be between 1 and {max_n}'}, status=400)
    legacy = bool(body.get('legacy'))

    data_dir = request.app[DATA_DIR_KEY]
    index = load_node_index(data_dir)
    source_ip = resolve_source_ip(index, source)
    if not source_ip:
        return web.json_response(
            {'error': f'source node not found in current snapshot: {source}'},
            status=404,
        )

    timeout_sec = float(cfg.get('traceTimeoutSec') or 120)
    if tool == 'stableroute':
        per_run = float(cfg.get('stablerouteTimeoutSec') or timeout_sec)
        timeout_sec = max(timeout_sec, per_run * max(n, 1))

    sem: asyncio.Semaphore = request.app[TRACE_SEM_KEY]
    try:
        await asyncio.wait_for(sem.acquire(), timeout=1.0)
    except asyncio.TimeoutError:
        return web.json_response({'error': 'too many concurrent trace requests'}, status=429)

    url = build_node_url(tool, source_ip, destination, n, legacy)
    logger.info('trace proxy %s source=%s(%s) dest=%s', tool, source, source_ip, destination)
    try:
        timeout = ClientTimeout(total=timeout_sec, sock_connect=15, sock_read=timeout_sec)
        async with ClientSession(timeout=timeout) as session:
            try:
                doc, via = await fetch_node_trace(session, url, tool, destination)
            except Exception as primary_exc:
                # Fall back to text CGI when JSON is empty/broken (known stableroute CGI issue).
                if 'format=json' in url:
                    text_url = build_node_url(
                        tool, source_ip, destination, n, legacy, want_json=False,
                    )
                    logger.info('trace proxy JSON failed (%s); retrying text CGI', primary_exc)
                    doc, via = await fetch_node_trace(session, text_url, tool, destination)
                    via = f'text-fallback:{via}'
                else:
                    raise
    except asyncio.TimeoutError:
        return web.json_response({'error': 'timed out waiting for node CGI'}, status=504)
    except web.HTTPException:
        raise
    except Exception as exc:
        logger.warning('trace proxy failed: %s', exc)
        return web.json_response({'error': f'proxy fetch failed: {exc}'}, status=502)
    finally:
        sem.release()

    if isinstance(doc, dict):
        doc['source'] = node_key(source)
        doc['proxy'] = {
            'sourceIp': source_ip,
            'via': via,
            'tool': tool,
        }
    return web.json_response(doc, dumps=lambda o: json.dumps(o, indent=2))
