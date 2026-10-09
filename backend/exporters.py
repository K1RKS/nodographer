"""
Nodographer node exports: KML (Google Earth Pro), CSV, and JSON.

Pure functions over the node records the poller builds for map_data.json
(plus a few extra fields). The layout follows worldmap.arednmesh.org's
data/out.{kml,csv,json} so tools that read those can read these.
"""

import csv
import io
import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple
from xml.sax.saxutils import escape


# (key, label, KML color aabbggrr) in display order; colors match the map legend
BANDS: List[Tuple[str, str, str]] = [
    ('900', '900 MHz', 'ffff00ff'),
    ('2ghz', '2.4 GHz', 'ff800080'),
    ('3ghz', '3.4 GHz', 'ffff0000'),
    ('5ghz', '5.8 GHz', 'ff00d7ff'),
    ('supernode', 'Supernode', 'ff3030e0'),
    ('noRF', 'No RF', 'ff808080'),
]
BAND_LABELS = {key: label for key, label, _ in BANDS}
UNPOLLED_COLOR = 'ff505050'

# (category, folder name, KML color, width)
LINK_CATEGORIES: List[Tuple[str, str, str, int]] = [
    ('dtd', 'DTD Links', 'fff020a0', 2),
    ('tunnel', 'Tunnel Links', 'ffb48246', 2),
    ('xlink', 'XLINK Links', 'ff008cff', 3),
    ('supernode', 'Supernode Links', 'ff3030e0', 2),
]
LINK_TYPE_CATEGORY = {'DTD': 'dtd', 'TUN': 'tunnel', 'WIREGUARD': 'tunnel', 'XLINK': 'xlink'}

NODE_ICON = 'http://maps.google.com/mapfiles/kml/shapes/target.png'

CSV_COLUMNS = [
    # worldmap's columns, in worldmap's order
    'node', 'wlan_ip', 'last_seen', 'uptime', 'hardware', 'model', 'firmware_version',
    'ssid', 'channel', 'mode', 'chanbw', 'active_tunnel_count', 'lat', 'lon',
    'wifi_mac_address', 'board_id', 'firmware_mfg', 'lan_ip',
    # Nodographer extras
    'band', 'freq', 'grid_square', 'description', 'hopsAway', 'protocol',
    'mesh_supernode', 'mesh_gateway', 'antGain', 'antBeam', 'antAzimuth',
    'antElevation', 'antHeight',
]

# (field, display name) shown in the KML balloon, in order
KML_NODE_FIELDS: List[Tuple[str, str]] = [
    ('hardware', 'Hardware'),
    ('board_id', 'Board ID'),
    ('model', 'Model'),
    ('firmware_mfg', 'Firmware Mfg.'),
    ('firmware_version', 'Firmware Version'),
    ('band', 'Band'),
    ('ssid', 'SSID'),
    ('channel', 'Channel'),
    ('freq', 'Frequency'),
    ('chanbw', 'Bandwidth'),
    ('wlan_ip', 'Mesh IP Address'),
    ('wifi_mac_address', 'WiFi MAC Address'),
    ('lan_ip', 'LAN IP Address'),
    ('lat', 'Latitude'),
    ('lon', 'Longitude'),
    ('grid_square', 'Grid Square'),
    ('antenna', 'Antenna'),
    ('last_seen', 'Last Polled (UTC)'),
    ('uptime', 'Uptime'),
    ('hopsAway', 'Hops Away'),
    ('active_tunnel_count', 'Active Tunnels'),
    ('services', 'Services'),
    ('description', 'Description'),
]


# ----- helpers -----

def _text(value: Any) -> str:
    if value is None:
        return ''
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _coord(value: Any) -> Optional[float]:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f != 0 else None


def _short_host(name: Any) -> str:
    return re.sub(r'\.local\.mesh\.?$', '', str(name or ''), flags=re.IGNORECASE)


def _service_names(services: Any) -> List[str]:
    if not isinstance(services, list):
        return []
    names = []
    for s in services:
        if isinstance(s, dict):
            name = s.get('name') or s.get('title') or s.get('service') or ''
        else:
            name = s
        if name:
            names.append(str(name))
    return names


def _antenna(node: Dict) -> str:
    parts = []
    desc = node.get('antDesc')
    if desc and desc != 'Not Available':
        parts.append(re.sub(r'&deg;', '\u00b0', str(desc)))
    for key, label, unit in (('antAzimuth', 'Az', '\u00b0'), ('antElevation', 'El', '\u00b0'),
                             ('antHeight', 'Ht', ' m')):
        v = node.get(key)
        if v is not None and v != '':
            parts.append(f'{label} {_text(v)}{unit}')
    return ', '.join(parts)


def _iso_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).strftime('%Y-%m-%dT%H:%M:%SZ')


def _located(nodes: Iterable[Dict]) -> List[Dict]:
    return [n for n in nodes if _coord(n.get('lat')) is not None and _coord(n.get('lon')) is not None]


# ----- unpolled ("ghost") nodes -----

def find_unpolled_nodes(nodes: Iterable[Dict]) -> List[Dict]:
    """Hosts seen only as link endpoints, with coordinates from the link (as the map shows them)."""
    nodes = list(nodes)
    known = {str(n.get('node', '')).lower() for n in nodes}
    ghosts: Dict[str, Dict] = {}
    for n in nodes:
        links = n.get('link_info')
        if not isinstance(links, dict):
            continue
        for dest_ip, link in links.items():
            if not isinstance(link, dict):
                continue
            host = _short_host(link.get('hostname') or dest_ip)
            key = host.lower()
            lat, lon = _coord(link.get('linkLat')), _coord(link.get('linkLon'))
            if key in known or key in ghosts or lat is None or lon is None:
                continue
            ghosts[key] = {'node': host, 'wlan_ip': dest_ip, 'lat': lat, 'lon': lon,
                           'seen_from': n.get('node', '')}
    return sorted(ghosts.values(), key=lambda g: g['node'].lower())


# ----- links -----

def _collect_links(nodes: List[Dict]) -> List[Dict]:
    by_name = {str(n.get('node', '')).lower(): n for n in nodes}
    seen = set()
    out = []
    for n in nodes:
        links = n.get('link_info')
        lat1, lon1 = _coord(n.get('lat')), _coord(n.get('lon'))
        if not isinstance(links, dict) or lat1 is None or lon1 is None:
            continue
        name1 = str(n.get('node', ''))
        for dest_ip, link in links.items():
            if not isinstance(link, dict):
                continue
            ltype = str(link.get('linkType') or '').upper()
            lat2, lon2 = _coord(link.get('linkLat')), _coord(link.get('linkLon'))
            if not ltype or lat2 is None or lon2 is None:
                continue
            host = _short_host(link.get('hostname') or dest_ip)
            other = by_name.get(host.lower())
            name2 = str(other.get('node')) if other else host
            key = (ltype, frozenset((name1.lower(), name2.lower())))
            if key in seen:
                continue
            seen.add(key)

            bands = {n.get('band'), other.get('band') if other else None}
            if 'supernode' in bands:
                category = 'supernode'
            elif ltype == 'RF':
                rf_band = n.get('band') if n.get('band') not in (None, '', 'noRF') else (other or {}).get('band')
                category = 'rf_' + (rf_band if rf_band in BAND_LABELS else 'other')
            else:
                category = LINK_TYPE_CATEGORY.get(ltype, 'other')

            out.append({
                'node1': name1, 'node2': name2, 'link_type': ltype, 'category': category,
                'coords': ((lon1, lat1), (lon2, lat2)),
                'distanceMiles': link.get('distanceMiles'), 'distanceKM': link.get('distanceKM'),
                'signal': link.get('signal'), 'noise': link.get('noise'),
            })
    return out


# ----- KML -----

_BALLOON_ROWS = ''.join(
    f'<tr><td>$[{field}/displayName]</td><td>$[{field}]</td></tr>' for field, _ in KML_NODE_FIELDS
)
NODE_BALLOON = (
    '<h3>$[name]</h3>'
    '<table border="1" cellpadding="3" style="border-collapse:collapse">'
    + _BALLOON_ROWS +
    '</table>'
)
LINK_BALLOON = '<h3>$[name]</h3>$[description]'


def _data(name: str, display: str, value: Any) -> str:
    return (f'<Data name="{escape(name)}"><displayName>{escape(display)}</displayName>'
            f'<value>{escape(_text(value))}</value></Data>')


def _icon_style_map(style_id: str, color: str, balloon: str) -> str:
    def style(sid: str, scale: float, label: float) -> str:
        return (
            f'<Style id="{sid}">'
            f'<IconStyle><color>{color}</color><scale>{scale}</scale>'
            f'<Icon><href>{NODE_ICON}</href></Icon>'
            '<hotSpot x="0.5" y="0.5" xunits="fraction" yunits="fraction"/></IconStyle>'
            f'<LabelStyle><scale>{label}</scale></LabelStyle>'
            f'<BalloonStyle><text><![CDATA[{balloon}]]></text></BalloonStyle>'
            '</Style>'
        )
    return (
        style(f'sn_{style_id}', 0.9, 0) + style(f'sh_{style_id}', 1.2, 1) +
        f'<StyleMap id="sm_{style_id}">'
        f'<Pair><key>normal</key><styleUrl>#sn_{style_id}</styleUrl></Pair>'
        f'<Pair><key>highlight</key><styleUrl>#sh_{style_id}</styleUrl></Pair>'
        '</StyleMap>'
    )


def _line_style_map(style_id: str, color: str, width: int) -> str:
    def style(sid: str, w: int) -> str:
        return (
            f'<Style id="{sid}"><LineStyle><color>{color}</color><width>{w}</width></LineStyle>'
            f'<BalloonStyle><text><![CDATA[{LINK_BALLOON}]]></text></BalloonStyle></Style>'
        )
    return (
        style(f'sn_{style_id}', width) + style(f'sh_{style_id}', width + 2) +
        f'<StyleMap id="sm_{style_id}">'
        f'<Pair><key>normal</key><styleUrl>#sn_{style_id}</styleUrl></Pair>'
        f'<Pair><key>highlight</key><styleUrl>#sh_{style_id}</styleUrl></Pair>'
        '</StyleMap>'
    )


def _node_placemark(node: Dict) -> str:
    values = dict(node)
    values['hardware'] = node.get('model', '')
    values['band'] = BAND_LABELS.get(node.get('band'), node.get('band', ''))
    values['antenna'] = _antenna(node)
    values['services'] = ', '.join(_service_names(node.get('services')))
    data = ''.join(_data(field, display, values.get(field, '')) for field, display in KML_NODE_FIELDS)
    return (
        '<Placemark>'
        f'<name>{escape(_text(node.get("node")))}</name>'
        '<Snippet maxLines="0"></Snippet>'
        f'<styleUrl>#sm_node_{escape(node.get("band") or "noRF")}</styleUrl>'
        f'<ExtendedData>{data}</ExtendedData>'
        f'<Point><coordinates>{_coord(node.get("lon"))},{_coord(node.get("lat"))},0</coordinates></Point>'
        '</Placemark>'
    )


def _unpolled_placemark(ghost: Dict) -> str:
    desc = (f'Discovered via links from {ghost.get("seen_from", "")}, '
            'but not polled directly.<br/>'
            f'{ghost["lat"]}, {ghost["lon"]}')
    return (
        '<Placemark>'
        f'<name>{escape(ghost["node"])}</name>'
        '<Snippet maxLines="0"></Snippet>'
        f'<description><![CDATA[{desc}]]></description>'
        '<styleUrl>#sm_node_unpolled</styleUrl>'
        f'<Point><coordinates>{ghost["lon"]},{ghost["lat"]},0</coordinates></Point>'
        '</Placemark>'
    )


def _link_placemark(link: Dict, style_id: str) -> str:
    n1, n2 = escape(link['node1']), escape(link['node2'])
    lines = [f'{n1}<br/> --- to --- <br/>{n2}', f'Type: {escape(link["link_type"])}']
    if link.get('distanceMiles') not in (None, ''):
        lines.append(f'Distance: {_text(link["distanceMiles"])} mi ({_text(link.get("distanceKM"))} km)')
    if link.get('signal') not in (None, ''):
        lines.append(f'Signal/Noise: {_text(link["signal"])} / {_text(link.get("noise"))} dBm')
    (lon1, lat1), (lon2, lat2) = link['coords']
    return (
        '<Placemark>'
        f'<name>{escape(link["link_type"])} Link</name>'
        f'<Snippet maxLines="2"><![CDATA[{n1}<br/>{n2}]]></Snippet>'
        f'<description><![CDATA[{"<br/>".join(lines)}]]></description>'
        f'<styleUrl>#sm_{style_id}</styleUrl>'
        '<ExtendedData>'
        + _data('node1', 'Node 1', link['node1'])
        + _data('node2', 'Node 2', link['node2'])
        + _data('link_type', 'Link Type', link['link_type'])
        + '</ExtendedData>'
        f'<LineString><tessellate>1</tessellate>'
        f'<coordinates>{lon1},{lat1},0 {lon2},{lat2},0</coordinates></LineString>'
        '</Placemark>'
    )


def _folder(name: str, body: str, visible: bool = True, open_: bool = False) -> str:
    return (f'<Folder><name>{escape(name)}</name><visibility>{int(visible)}</visibility>'
            f'<open>{int(open_)}</open>{body}</Folder>')


def build_kml(nodes: Iterable[Dict], ghosts: Iterable[Dict], title: str,
              generated_at: Optional[datetime] = None) -> str:
    generated_at = generated_at or datetime.now(timezone.utc)
    stamp = _iso_utc(generated_at)
    located = _located(nodes)
    ghosts = list(ghosts)

    styles = [_icon_style_map(f'node_{key}', color, NODE_BALLOON) for key, _, color in BANDS]
    styles.append(_icon_style_map('node_unpolled', UNPOLLED_COLOR, '<h3>$[name]</h3>$[description]'))
    for key, _, color in BANDS:
        if key not in ('supernode', 'noRF'):
            styles.append(_line_style_map(f'link_rf_{key}', color, 2))
    styles.append(_line_style_map('link_rf_other', 'ff808080', 2))
    for key, _, color, width in LINK_CATEGORIES:
        styles.append(_line_style_map(f'link_{key}', color, width))
    styles.append(_line_style_map('link_other', 'ff808080', 1))

    node_folders = []
    for key, label, _ in BANDS:
        band_nodes = sorted((n for n in located if (n.get('band') or 'noRF') == key),
                            key=lambda n: str(n.get('node', '')).lower())
        if band_nodes:
            node_folders.append(_folder(f'{label} ({len(band_nodes)})',
                                        ''.join(_node_placemark(n) for n in band_nodes)))
    if ghosts:
        node_folders.append(_folder(f'Unpolled ({len(ghosts)})',
                                    ''.join(_unpolled_placemark(g) for g in ghosts)))

    links = _collect_links(located)
    by_cat: Dict[str, List[Dict]] = {}
    for link in links:
        by_cat.setdefault(link['category'], []).append(link)

    rf_folders = []
    for key, label, _ in BANDS + [('other', 'Other', '')]:
        cat = f'rf_{key}'
        if by_cat.get(cat):
            rf_folders.append(_folder(f'{label} ({len(by_cat[cat])})',
                                      ''.join(_link_placemark(l, f'link_{cat}') for l in by_cat[cat])))
    link_folders = []
    if rf_folders:
        link_folders.append(_folder('RF Links', ''.join(rf_folders)))
    for key, label, _, _ in LINK_CATEGORIES + [('other', 'Other Links', '', 0)]:
        if by_cat.get(key):
            link_folders.append(_folder(f'{label} ({len(by_cat[key])})',
                                        ''.join(_link_placemark(l, f'link_{key}') for l in by_cat[key])))

    description = (f'Generated: {stamp}<br/>'
                   f'{len(located)} nodes, {len(ghosts)} unpolled, {len(links)} links<br/>'
                   'Generated by Nodographer')
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">\n'
        '<Document id="nodographer_kml">'
        f'<name>{escape(title or "MeshMap")}</name>'
        '<open>1</open>'
        f'<Snippet maxLines="1">{stamp}</Snippet>'
        f'<description><![CDATA[{description}]]></description>\n'
        + '\n'.join(styles) + '\n'
        + _folder('Nodes', ''.join(node_folders), open_=True) + '\n'
        + _folder('Links', ''.join(link_folders)) + '\n'
        '</Document>\n</kml>\n'
    )


# ----- CSV -----

def build_csv(nodes: Iterable[Dict]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator='\n')
    writer.writerow(CSV_COLUMNS)
    for n in sorted(nodes, key=lambda n: str(n.get('node', '')).lower()):
        row = dict(n)
        row['hardware'] = n.get('model', '')
        row['mode'] = ''
        row['band'] = BAND_LABELS.get(n.get('band'), n.get('band', ''))
        writer.writerow([_text(row.get(col, '')) for col in CSV_COLUMNS])
    return buf.getvalue()


# ----- JSON -----

def _json_node(n: Dict) -> Dict:
    links = n.get('link_info') if isinstance(n.get('link_info'), dict) else {}
    return {'data': {
        'api_version': n.get('api_version', ''),
        'node': n.get('node', ''),
        'ip': n.get('wlan_ip', ''),
        'lat': n.get('lat'),
        'lon': n.get('lon'),
        'gridsquare': n.get('grid_square', ''),
        'node_details': {
            'model': n.get('model', ''),
            'description': n.get('description', ''),
            'board_id': n.get('board_id', ''),
            'firmware_mfg': n.get('firmware_mfg', ''),
            'firmware_version': n.get('firmware_version', ''),
            'mesh_gateway': str(n.get('mesh_gateway', 'false')).lower() == 'true',
            'mesh_supernode': str(n.get('mesh_supernode', 'false')).lower() == 'true',
            'hardware': n.get('model', ''),
        },
        'tunnels': {'active_tunnel_count': n.get('active_tunnel_count', 0)},
        'meshrf': {
            'status': n.get('meshRF') or ('off' if n.get('band') in ('noRF', 'supernode') else 'on'),
            'ssid': n.get('ssid', ''),
            'channel': n.get('channel', ''),
            'chanbw': n.get('chanbw', ''),
            'freq': n.get('freq', ''),
        },
        'sysinfo': {'uptime': n.get('uptime', ''), 'loads': n.get('loadavg', [])},
        'lan_ip': n.get('lan_ip', ''),
        'wifi_mac_address': n.get('wifi_mac_address', ''),
        'last_seen': n.get('last_seen', ''),
        'band': BAND_LABELS.get(n.get('band'), n.get('band', '')),
        'hopsAway': n.get('hopsAway'),
        'protocol': n.get('protocol', ''),
        'services': _service_names(n.get('services')),
        'links': [
            {'hostname': _short_host(l.get('hostname') or ip), 'linkType': l.get('linkType', '')}
            for ip, l in links.items() if isinstance(l, dict)
        ],
    }}


def build_json(nodes: Iterable[Dict], generated_at: Optional[datetime] = None, default=None) -> str:
    generated_at = generated_at or datetime.now(timezone.utc)
    doc = {
        'version': '1',
        'date': int(generated_at.timestamp() * 1000),
        'generator': 'Nodographer',
        'nodeInfo': [_json_node(n) for n in sorted(nodes, key=lambda n: str(n.get('node', '')).lower())],
    }
    return json.dumps(doc, default=default, separators=(',', ':'))
