import json

from exporters import build_json


def node(**extra):
    base = {
        'node': 'K1RKS-Tower', 'wlan_ip': '10.0.0.1', 'lat': 45.36683, 'lon': -122.76617, 'band': '5ghz',
        'freq': 5805, 'link_info': {
            '10.0.0.2': {'hostname': 'Parrett-Sector.local.mesh', 'linkType': 'RF', 'distanceKM': 9.8,
                         'bearing': 237.4, 'signal': -64, 'noise': -92, 'linkLat': 45.33, 'linkLon': -122.88},
            '10.0.0.3': {'hostname': 'Unplaced', 'linkType': 'RF', 'signal': -80, 'noise': -95},
            '10.0.0.4': {'hostname': 'Hub', 'linkType': 'DTD', 'linkLat': 0, 'linkLon': 0},
        },
    }
    base.update(extra)
    return base


def links_of(doc):
    return {link['id']: link for link in doc['nodeInfo'][0]['data']['links']}


def test_links_carry_peer_position():
    links = links_of(json.loads(build_json([node()])))
    assert links['parrett-sector']['lat'] == 45.33
    assert links['parrett-sector']['lon'] == -122.88


def test_links_without_position_are_null():
    links = links_of(json.loads(build_json([node()])))
    assert links['unplaced']['lat'] is None and links['unplaced']['lon'] is None
    assert links['hub']['lat'] is None and links['hub']['lon'] is None


def test_existing_link_fields_unchanged():
    link = links_of(json.loads(build_json([node()])))['parrett-sector']
    assert link == {'hostname': 'Parrett-Sector', 'id': 'parrett-sector', 'linkType': 'RF', 'distance_km': 9.8,
                    'bearing_deg': 237.4, 'signal_dbm': -64.0, 'noise_dbm': -92.0, 'lat': 45.33, 'lon': -122.88}
