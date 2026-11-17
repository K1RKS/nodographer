"""
Parse aredn-traceroute / stableroute text reports into schemaVersion-1 JSON.

Used by the meshinfo trace proxy when a node returns HTML/text (older APKs)
and by tests. Matches the hop / Path shapes documented in the package READMEs.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

HOP_RE = re.compile(
    r'^\s*(\d+)\s+(?:'
    r'\*\s*(?:\*\s*)?|'
    r'([^\s]+)\s+\(([0-9.]+)\)(?:\s+(\d+(?:\.\d+)?)\s+ms)?'
    r'(?:\s+[0-9.+-]+,[0-9.+-]+)?'
    r'(?:\s+(DtD|RF|WG|Xlink|-))?'
    r'.*|'
    r'([0-9.]+)\s+(\d+(?:\.\d+)?)\s+ms'
    r'(?:\s+(DtD|RF|WG|Xlink|-))?'
    r'.*'
    r')$'
)

STABLE_HOP_RE = re.compile(
    r'^\s*(\d+)\s+'
    r'(?:\*\s*|'
    r'([^\s(]+)\s+\(([0-9.]+)\)(?:\s+(DtD|RF|WG|Xlink|-))?\s*'
    r'|([0-9.]+)(?:\s+(DtD|RF|WG|Xlink|-))?\s*)'
    r'(?:avg\s+(\d+)ms\s+\+-\s+(\d+)ms)?'
)

PATH_HEADER_RE = re.compile(
    r'^Path\s+(\d+):\s+(\d+)/(\d+)\s+\((\d+)%\)(?:\s+\[unreachable\])?',
    re.I,
)


def node_key(name: Optional[str]) -> str:
    if not name:
        return ''
    return re.sub(r'\.local\.mesh$', '', str(name), flags=re.I).lower()


def hop_identity(hop: Dict[str, Any]) -> str:
    if hop.get('unreachable'):
        return '*'
    host = node_key(hop.get('hostname'))
    ip = hop.get('ip')
    if host and host != ip:
        return host
    if ip:
        return str(ip)
    return '*'


def path_key_from_hops(hops: List[Dict[str, Any]]) -> str:
    return '|'.join(hop_identity(h) for h in hops)


def _rtt_int(value: Optional[str]) -> Optional[int]:
    if value is None or value == '':
        return None
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return None


def parse_hop_line(line: str) -> Optional[Dict[str, Any]]:
    line = line.strip()
    if not line:
        return None
    if re.match(r'^\d+\s+\*', line):
        m = re.match(r'^(\d+)\s+\*', line)
        return {
            'hop': int(m.group(1)),
            'hostname': None,
            'ip': None,
            'linkType': None,
            'rttMs': None,
            'rttAvgMs': None,
            'rttDevMs': None,
            'lat': None,
            'lon': None,
            'unreachable': True,
        }
    m = re.match(
        r'^(\d+)\s+([^\s]+)\s+\(([0-9.]+)\)\s+(\d+(?:\.\d+)?)\s+ms'
        r'(?:\s+[0-9.+-]+,[0-9.+-]+)?'
        r'(?:\s+(DtD|RF|WG|Xlink|-))?',
        line,
    )
    if m:
        return {
            'hop': int(m.group(1)),
            'hostname': node_key(m.group(2)) or m.group(2),
            'ip': m.group(3),
            'linkType': m.group(5),
            'rttMs': _rtt_int(m.group(4)),
            'rttAvgMs': None,
            'rttDevMs': None,
            'lat': None,
            'lon': None,
            'unreachable': False,
        }
    m = re.match(
        r'^(\d+)\s+([0-9.]+)\s+(\d+(?:\.\d+)?)\s+ms(?:\s+(DtD|RF|WG|Xlink|-))?',
        line,
    )
    if m:
        return {
            'hop': int(m.group(1)),
            'hostname': m.group(2),
            'ip': m.group(2),
            'linkType': m.group(4),
            'rttMs': _rtt_int(m.group(3)),
            'rttAvgMs': None,
            'rttDevMs': None,
            'lat': None,
            'lon': None,
            'unreachable': False,
        }
    return None


def parse_stable_hop_line(line: str) -> Optional[Dict[str, Any]]:
    line = line.strip()
    if not line:
        return None
    m = re.match(
        r'^(\d+)\s+\*\s*(?:avg\s+(\d+)ms\s+\+-\s+(\d+)ms)?',
        line,
    )
    if m:
        avg = _rtt_int(m.group(2))
        return {
            'hop': int(m.group(1)),
            'hostname': None,
            'ip': None,
            'linkType': None,
            'rttMs': avg,
            'rttAvgMs': avg,
            'rttDevMs': _rtt_int(m.group(3)),
            'lat': None,
            'lon': None,
            'unreachable': True,
        }
    m = re.match(
        r'^(\d+)\s+([^\s(]+)\s+\(([0-9.]+)\)(?:\s+(DtD|RF|WG|Xlink|-))?\s*'
        r'(?:avg\s+(\d+)ms\s+(?:\+-|\u00b1)\s+(\d+)ms)?',
        line,
    )
    if m:
        avg = _rtt_int(m.group(5))
        return {
            'hop': int(m.group(1)),
            'hostname': node_key(m.group(2)) or m.group(2),
            'ip': m.group(3),
            'linkType': m.group(4),
            'rttMs': avg,
            'rttAvgMs': avg,
            'rttDevMs': _rtt_int(m.group(6)),
            'lat': None,
            'lon': None,
            'unreachable': False,
        }
    # IP-only hop: "3 172.31.69.37 -  avg 59ms +- 22ms"
    m = re.match(
        r'^(\d+)\s+(\d{1,3}(?:\.\d{1,3}){3})(?:\s+(DtD|RF|WG|Xlink|-))?\s*'
        r'(?:avg\s+(\d+)ms\s+(?:\+-|\u00b1)\s+(\d+)ms)?',
        line,
    )
    if m:
        avg = _rtt_int(m.group(4))
        link = m.group(3)
        if link == '-':
            link = None
        return {
            'hop': int(m.group(1)),
            'hostname': m.group(2),
            'ip': m.group(2),
            'linkType': link,
            'rttMs': avg,
            'rttAvgMs': avg,
            'rttDevMs': _rtt_int(m.group(5)),
            'lat': None,
            'lon': None,
            'unreachable': False,
        }
    return None


def strip_html_pre(text: str) -> str:
    """Pull plain text out of CGI HTML <pre> wrappers / keepalives."""
    text = re.sub(r'(?is)<script.*?>.*?</script>', '', text)
    text = re.sub(r'(?is)</?html[^>]*>|</?head[^>]*>|</?body[^>]*>|</?title[^>]*>', '\n', text)
    text = re.sub(r'(?is)<pre[^>]*>|</pre>', '\n', text)
    text = re.sub(r'(?is)<[^>]+>', '', text)
    lines = []
    for line in text.splitlines():
        if '__sr_ka__' in line:
            continue
        if re.match(r'^run\s+\d+/\d+\s*$', line.strip()):
            continue
        if re.match(r'^probing\s+\d+', line.strip()):
            continue
        lines.append(line)
    return '\n'.join(lines)


def parse_traceroute_text(text: str, destination: Optional[str] = None) -> Dict[str, Any]:
    body = strip_html_pre(text)
    hops: List[Dict[str, Any]] = []
    dest = destination
    for line in body.splitlines():
        m = re.match(r'^traceroute to\s+(\S+)', line, re.I)
        if m and not dest:
            dest = node_key(m.group(1).rstrip(',')) or m.group(1)
        hop = parse_hop_line(line)
        if hop:
            hops.append(hop)
    dest_short = node_key(dest) if dest else None
    reached = bool(hops) and not hops[-1].get('unreachable')
    if dest_short and hops:
        last = hops[-1]
        if node_key(last.get('hostname')) == dest_short or last.get('ip') == dest:
            reached = not last.get('unreachable')
    return {
        'schemaVersion': 1,
        'tool': 'aredn-traceroute',
        'version': None,
        'destination': dest_short,
        'source': None,
        'using': 'aredn-traceroute',
        'runs': 1,
        'summary': {
            'uniquePaths': 1 if hops else 0,
            'shortest': len(hops),
            'longest': len(hops),
            'unreachable': 0 if reached else 1,
            'mostCommonCount': 1 if hops else 0,
        },
        'paths': [{
            'index': 1,
            'key': path_key_from_hops(hops),
            'count': 1,
            'reached': reached,
            'hops': hops,
        }] if hops else [],
    }


def parse_stableroute_text(text: str, destination: Optional[str] = None) -> Dict[str, Any]:
    body = strip_html_pre(text)
    dest = destination
    runs = 0
    unreachable = 0
    shortest = 0
    longest = 0
    using = 'using traceroute'
    paths: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None

    for raw in body.splitlines():
        line = raw.rstrip()
        m = re.match(r'^stableroute\([^)]+\):\s+destination\s+(\S+)\s+runs\s+(\d+)', line, re.I)
        if m:
            dest = m.group(1)
            runs = int(m.group(2))
            continue
        if line.startswith('using '):
            using = line.strip()
            continue
        m = re.match(r'^\s*unique paths:\s+(\d+)', line)
        if m:
            continue
        m = re.match(r'^\s*shortest route:\s+(\d+)', line)
        if m:
            shortest = int(m.group(1))
            continue
        m = re.match(r'^\s*longest route:\s+(\d+)', line)
        if m:
            longest = int(m.group(1))
            continue
        m = re.match(r'^\s*Unreachable:\s+(\d+)', line, re.I)
        if m:
            unreachable = int(m.group(1))
            continue
        m = PATH_HEADER_RE.match(line)
        if m:
            if current:
                paths.append(current)
            current = {
                'index': int(m.group(1)),
                'key': '',
                'count': int(m.group(2)),
                'reached': '[unreachable]' not in line.lower(),
                'hops': [],
            }
            if not runs:
                runs = int(m.group(3))
            continue
        if current is not None:
            hop = parse_stable_hop_line(line)
            if hop:
                current['hops'].append(hop)

    if current:
        paths.append(current)

    for path in paths:
        path['key'] = path_key_from_hops(path['hops'])
        if not shortest or len(path['hops']) < shortest:
            shortest = len(path['hops']) if path['hops'] else shortest
        if len(path['hops']) > longest:
            longest = len(path['hops'])

    top = paths[0]['count'] if paths else 0
    return {
        'schemaVersion': 1,
        'tool': 'stableroute',
        'version': None,
        'destination': node_key(dest) if dest else None,
        'source': None,
        'using': using,
        'runs': runs or sum(p['count'] for p in paths),
        'summary': {
            'uniquePaths': len(paths),
            'shortest': shortest,
            'longest': longest,
            'unreachable': unreachable,
            'mostCommonCount': top,
        },
        'paths': paths,
    }


def coerce_trace_document(payload: Any, tool: str, destination: Optional[str] = None) -> Dict[str, Any]:
    """Accept already-parsed JSON, a JSON string, or text/HTML report body."""
    if isinstance(payload, dict) and payload.get('schemaVersion') == 1 and payload.get('paths') is not None:
        return payload
    if isinstance(payload, (bytes, bytearray)):
        payload = payload.decode('utf-8', errors='replace')
    if isinstance(payload, str):
        text = payload.strip()
        if text.startswith('{'):
            import json
            try:
                doc = json.loads(text)
                if isinstance(doc, dict) and doc.get('paths') is not None:
                    return doc
            except json.JSONDecodeError:
                pass
        if tool == 'stableroute' or 'Path 1:' in text or text.lower().startswith('stableroute('):
            return parse_stableroute_text(text, destination)
        return parse_traceroute_text(text, destination)
    raise ValueError('unsupported trace payload')
