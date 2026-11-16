import json

import pytest

from api import create_app
from publisher import SnapshotPublisher


def publish_with_node(pub, node='nodeA', ip='10.1.2.3'):
    map_data = {
        'mapInfo': {'localnode': node},
        'allDevices': {
            '2ghz': [{
                'node': node,
                'wlan_ip': ip,
                'lat': 45.0,
                'lon': -122.0,
            }],
        },
    }
    return pub.publish({
        'map_data.json': json.dumps(map_data),
        'node_report_data.json': '[]',
        'nodes.kml': '<kml/>',
        'nodes.csv': 'node\n',
        'nodes.json': json.dumps({'nodes': [{'node': node, 'wlan_ip': ip}]}),
    }, {'nodeCount': 1})


async def test_trace_disabled_by_default(aiohttp_client, tmp_path, monkeypatch):
    pub = SnapshotPublisher(tmp_path)
    publish_with_node(pub)
    client = await aiohttp_client(create_app(tmp_path))
    resp = await client.post('/api/v1/trace', json={
        'tool': 'traceroute',
        'source': 'nodeA',
        'destination': 'nodeB',
    })
    assert resp.status == 403


async def test_trace_unknown_source(aiohttp_client, tmp_path):
    pub = SnapshotPublisher(tmp_path)
    publish_with_node(pub)
    client = await aiohttp_client(create_app(tmp_path, trace_cfg={'enabled': True}))
    resp = await client.post('/api/v1/trace', json={
        'tool': 'traceroute',
        'source': 'missing-node',
        'destination': 'nodeB',
    })
    assert resp.status == 404


async def test_trace_localnode_resolves_via_dns(aiohttp_client, tmp_path, monkeypatch):
    pub = SnapshotPublisher(tmp_path)
    publish_with_node(pub, node='other-node', ip='10.9.9.9')

    monkeypatch.setattr('trace_proxy.dns_resolve_ipv4', lambda host: '10.1.2.3')

    async def fake_fetch(session, url, tool, destination):
        assert '10.1.2.3' in url
        return {
            'schemaVersion': 1,
            'tool': 'aredn-traceroute',
            'destination': 'nodeb',
            'paths': [{
                'index': 1,
                'key': 'a|b',
                'count': 1,
                'reached': True,
                'hops': [{'hop': 1, 'hostname': 'b', 'ip': '10.0.0.2'}],
            }],
        }, 'json'

    monkeypatch.setattr('trace_proxy.fetch_node_trace', fake_fetch)
    client = await aiohttp_client(create_app(tmp_path, trace_cfg={'enabled': True}))
    resp = await client.post('/api/v1/trace', json={
        'tool': 'traceroute',
        'source': 'localnode',
        'destination': 'nodeB',
    })
    assert resp.status == 200
    doc = await resp.json()
    assert doc['proxy']['sourceIp'] == '10.1.2.3'
    assert doc['source'] == 'localnode'


async def test_trace_rejects_empty_paths(aiohttp_client, tmp_path, monkeypatch):
    pub = SnapshotPublisher(tmp_path)
    publish_with_node(pub)

    async def fake_fetch(session, url, tool, destination):
        return {
            'schemaVersion': 1,
            'tool': 'stableroute',
            'destination': 'nodeb',
            'paths': [],
        }, 'text'

    monkeypatch.setattr('trace_proxy.fetch_node_trace', fake_fetch)
    client = await aiohttp_client(create_app(tmp_path, trace_cfg={'enabled': True}))
    resp = await client.post('/api/v1/trace', json={
        'tool': 'stableroute',
        'source': 'nodeA',
        'destination': 'nodeB',
        'n': 2,
    })
    assert resp.status == 502
    body = await resp.json()
    assert 'no paths' in body['error']


async def test_trace_proxies_and_injects_source(aiohttp_client, tmp_path, monkeypatch):
    pub = SnapshotPublisher(tmp_path)
    publish_with_node(pub)

    async def fake_fetch(session, url, tool, destination):
        assert '10.1.2.3' in url
        assert 'format=json' in url
        return {
            'schemaVersion': 1,
            'tool': 'aredn-traceroute',
            'destination': 'nodeb',
            'paths': [{
                'index': 1,
                'key': 'nodea|nodeb',
                'count': 1,
                'reached': True,
                'hops': [{'hop': 1, 'hostname': 'nodeb', 'ip': '10.1.2.4'}],
            }],
        }, 'json'

    monkeypatch.setattr('trace_proxy.fetch_node_trace', fake_fetch)
    client = await aiohttp_client(create_app(tmp_path, trace_cfg={
        'enabled': True,
        'traceMaxConcurrent': 2,
        'stablerouteMaxN': 20,
        'traceTimeoutSec': 30,
    }))
    resp = await client.post('/api/v1/trace', json={
        'tool': 'traceroute',
        'source': 'nodeA',
        'destination': 'nodeB',
    })
    assert resp.status == 200
    doc = await resp.json()
    assert doc['source'] == 'nodea'
    assert doc['proxy']['sourceIp'] == '10.1.2.3'
    assert doc['proxy']['via'] == 'json'


async def test_trace_cors_allows_post_when_enabled(aiohttp_client, tmp_path):
    pub = SnapshotPublisher(tmp_path)
    publish_with_node(pub)
    client = await aiohttp_client(create_app(tmp_path, trace_cfg={'enabled': True}))
    pre = await client.options('/api/v1/trace', headers={
        'Origin': 'https://map.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
    })
    assert pre.status == 204
    assert 'POST' in pre.headers['Access-Control-Allow-Methods']
