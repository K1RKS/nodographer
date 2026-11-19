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
import socket
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
LOCALNODE_ALIASES = frozenset({'localnode', 'localnode.local.mesh'})


def is_private_ipv4(ip: str) -> bool:
    if not re.match(r'^\d{1,3}(?:\.\d{1,3}){3}$', ip):
        return False
    a, b, _, _ = (int(p) for p in ip.split('.'))
    if a == 10:
        return True
    if a == 172 and 16 <= b <= 31:
        return True
    if a == 192 and b == 168:
        return True
    # AREDN dtunnels / CGNAT-ish mesh ranges sometimes used on tunnels
    if a == 100 and 64 <= b <= 127:
        return True
    return False


def dns_resolve_ipv4(hostname: str) -> Optional[str]:
    try:
        infos = socket.getaddrinfo(hostname, None, socket.AF_INET, socket.SOCK_STREAM)
    except socket.gaierror:
        return None
    for info in infos:
        ip = info[4][0]
        if is_private_ipv4(ip):
            return ip
    return None


def is_localnode_alias(name: str) -> bool:
    raw = (name or '').strip().lower()
    if raw in LOCALNODE_ALIASES:
        return True
    return node_key(raw) == 'localnode'


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

    map_info_localnode: Optional[str] = None
    map_path = snap / 'map_data.json'
    if map_path.exists():
        try:
            data = json.loads(map_path.read_text(encoding='utf-8'))
            map_info_localnode = ((data or {}).get('mapInfo') or {}).get('localnode')
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

    # mapInfo.localnode is often "localnode.local.mesh" and is not a device row.
    # Resolve it on the meshinfo host so Source=localnode works for live traces.
    for alias in (map_info_localnode, 'localnode', 'localnode.local.mesh'):
        if not alias or not is_localnode_alias(str(alias)):
            continue
        host = str(alias).strip()
        if '.' not in host:
            host = 'localnode.local.mesh'
        ip = dns_resolve_ipv4(host)
        if not ip:
            continue
        # Prefer an already-indexed IP if DNS matched a known node address.
        if ip in index:
            resolved = index[ip]
        else:
            resolved = ip
        for name in ('localnode', 'localnode.local.mesh', str(alias).strip()):
            key = node_key(name) or name.lower()
            index[key] = resolved
            index[f'{key}.local.mesh'] = resolved
            index[name.lower()] = resolved
        break

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
    # Last chance: DNS for the special localnode alias only (SSRF-safe: private IP).
    if is_localnode_alias(raw):
        host = raw if '.' in raw else 'localnode.local.mesh'
        ip = dns_resolve_ipv4(host)
        if ip:
            return index.get(ip, ip)
    return None


def _hostname_for_ip(data_dir: Path, ip: str) -> Optional[str]:
    """Best-effort mesh node hostname for an IP from the current snapshot."""
    snap = current_snapshot_dir(data_dir)
    if snap is None or not ip:
        return None
    map_path = snap / 'map_data.json'
    if not map_path.exists():
        return None
    try:
        data = json.loads(map_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return None
    devices = (data or {}).get('allDevices') or {}
    if not isinstance(devices, dict):
        return None
    for band_nodes in devices.values():
        if not isinstance(band_nodes, list):
            continue
        for node in band_nodes:
            if not isinstance(node, dict):
                continue
            if str(node.get('wlan_ip') or '') == ip:
                name = node.get('node')
                if name:
                    return str(name)
    return None


def resolve_localnode_info(data_dir: Path) -> Dict[str, Optional[str]]:
    """
    Describe what "localnode" means on this meshinfo host.

    alias: configured/DNS name (usually localnode.local.mesh)
    ip: private IPv4 from DNS (SSRF-safe), if any
    name: polled mesh node hostname for that IP, if present in the snapshot

    Public meshinfo VMs often resolve localnode to themselves (or a gateway)
    with no CGI — then name is null and the map should not default Source to it.
    """
    alias = 'localnode.local.mesh'
    snap = current_snapshot_dir(data_dir)
    if snap is not None:
        map_path = snap / 'map_data.json'
        if map_path.exists():
            try:
                data = json.loads(map_path.read_text(encoding='utf-8'))
                configured = ((data or {}).get('mapInfo') or {}).get('localnode')
                if configured:
                    alias = str(configured).strip() or alias
            except (OSError, json.JSONDecodeError):
                pass
    host = alias if '.' in alias else 'localnode.local.mesh'
    ip = dns_resolve_ipv4(host)
    name = _hostname_for_ip(data_dir, ip) if ip else None
    # If DNS IP is already indexed under a short name, prefer that.
    if ip and not name:
        index = load_node_index(data_dir)
        for key, indexed_ip in index.items():
            if indexed_ip != ip:
                continue
            if is_localnode_alias(key) or key == ip:
                continue
            # Prefer bare hostnames over dotted FQDNs.
            if '.' not in key:
                name = key
                break
            if name is None:
                name = key.split('.')[0]
    return {'alias': alias, 'ip': ip, 'name': name}


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
            detail = f'node CGI returned HTTP {resp.status}'
            if resp.status == 404:
                detail = (
                    f'{tool} CGI not found on source node (HTTP 404). '
                    f'Install the {tool} package on that node, or pick a different Source.'
                )
            raise web.HTTPBadGateway(
                text=json.dumps({
                    'error': detail,
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


def _should_fallback_to_text(exc: BaseException, url: str) -> bool:
    """Retry text CGI only for empty/broken JSON — not HTTP errors from the node."""
    if 'format=json' not in url:
        return False
    if isinstance(exc, web.HTTPException):
        return False
    return True


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
                if _should_fallback_to_text(primary_exc, url):
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

    if not isinstance(doc, dict) or not (doc.get('paths') or []):
        return web.json_response(
            {
                'error': (
                    f'{tool} returned no paths from {source} ({source_ip}). '
                    'Check destination name, package version, and that the source can reach the dest.'
                ),
            },
            status=502,
        )

    doc['source'] = node_key(source)
    doc['proxy'] = {
        'sourceIp': source_ip,
        'via': via,
        'tool': tool,
    }
    return web.json_response(doc, dumps=lambda o: json.dumps(o, indent=2))
