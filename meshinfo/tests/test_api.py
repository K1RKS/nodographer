import json

import pytest

from api import create_app
from publisher import SnapshotPublisher


@pytest.fixture
def publisher(tmp_path):
    return SnapshotPublisher(tmp_path)


def publish(pub, n=1):
    manifest = pub.publish({
        'map_data.json': json.dumps({'mapInfo': {'n': n}}),
        'node_report_data.json': '[]',
        'nodes.kml': '<kml/>',
        'nodes.csv': 'node\n',
        'nodes.json': '{}',
    }, {'nodeCount': 10})
    pub.finish_cycle('idle', manifest=manifest)
    return manifest


async def test_no_snapshot_returns_503(aiohttp_client, tmp_path):
    client = await aiohttp_client(create_app(tmp_path))
    resp = await client.get('/api/v1/map_data.json')
    assert resp.status == 503
    assert resp.headers['Retry-After']
    assert (await client.get('/healthz')).status == 503


async def test_serves_current_snapshot(aiohttp_client, tmp_path, publisher):
    manifest = publish(publisher)
    client = await aiohttp_client(create_app(tmp_path))
    resp = await client.get('/api/v1/map_data.json')
    assert resp.status == 200
    assert resp.content_type == 'application/json'
    assert resp.headers['X-Meshinfo-Snapshot'] == manifest['snapshotId']
    assert resp.headers['Cache-Control'] == 'no-cache'
    assert (await resp.json())['mapInfo']['n'] == 1

    kml = await client.get('/api/v1/nodes.kml')
    assert kml.content_type == 'application/vnd.google-earth.kml+xml'
    assert (await client.get('/api/v1/nodes.csv')).content_type == 'text/csv'
    assert (await client.get('/api/v1/manifest.json')).status == 200


async def test_unknown_and_traversal_paths_404(aiohttp_client, tmp_path, publisher):
    publish(publisher)
    (tmp_path / 'secret.json').write_text('{}')
    client = await aiohttp_client(create_app(tmp_path))
    assert (await client.get('/api/v1/secret.json')).status == 404
    assert (await client.get('/api/v1/..%2Fsecret.json')).status == 404
    assert (await client.get('/api/v1/../secret.json')).status == 404


async def test_etag_and_304(aiohttp_client, tmp_path, publisher):
    publish(publisher)
    client = await aiohttp_client(create_app(tmp_path))
    first = await client.get('/api/v1/map_data.json')
    etag = first.headers['ETag']
    again = await client.get('/api/v1/map_data.json', headers={'If-None-Match': etag})
    assert again.status == 304

    publish(publisher, n=2)
    changed = await client.get('/api/v1/map_data.json', headers={'If-None-Match': etag})
    assert changed.status == 200
    assert changed.headers['ETag'] != etag
    assert (await changed.json())['mapInfo']['n'] == 2


async def test_cors_wildcard(aiohttp_client, tmp_path, publisher):
    publish(publisher)
    client = await aiohttp_client(create_app(tmp_path))
    resp = await client.get('/api/v1/map_data.json', headers={'Origin': 'https://map.example'})
    assert resp.headers['Access-Control-Allow-Origin'] == '*'
    assert 'ETag' in resp.headers['Access-Control-Expose-Headers']
    pre = await client.options('/api/v1/map_data.json', headers={
        'Origin': 'https://map.example', 'Access-Control-Request-Method': 'GET'})
    assert pre.status == 204
    assert pre.headers['Access-Control-Allow-Origin'] == '*'


async def test_cors_allow_list(aiohttp_client, tmp_path, publisher):
    publish(publisher)
    client = await aiohttp_client(create_app(tmp_path, ['https://ok.example']))
    ok = await client.get('/api/v1/map_data.json', headers={'Origin': 'https://ok.example'})
    assert ok.headers['Access-Control-Allow-Origin'] == 'https://ok.example'
    bad = await client.get('/api/v1/map_data.json', headers={'Origin': 'https://bad.example'})
    assert 'Access-Control-Allow-Origin' not in bad.headers
    missing = await client.get('/api/v1/nope.json', headers={'Origin': 'https://ok.example'})
    assert missing.status == 404
    assert missing.headers['Access-Control-Allow-Origin'] == 'https://ok.example'


async def test_status_merges_manifest(aiohttp_client, tmp_path, publisher):
    manifest = publish(publisher)
    publisher.start_cycle(7)
    client = await aiohttp_client(create_app(tmp_path))
    status = await (await client.get('/api/v1/status.json')).json()
    assert status['state'] == 'scanning'
    assert status['cycle'] == 7
    assert status['snapshot']['snapshotId'] == manifest['snapshotId']
    assert status['snapshot']['nodeCount'] == 10
    assert status['ageSec'] >= 0
    health = await (await client.get('/healthz')).json()
    assert health['ok'] and health['snapshot'] == manifest['snapshotId']


async def test_gzip(aiohttp_client, tmp_path, publisher):
    publisher.publish({'map_data.json': json.dumps({'x': 'y' * 5000})}, {'nodeCount': 1})
    client = await aiohttp_client(create_app(tmp_path))
    resp = await client.get('/api/v1/map_data.json', headers={'Accept-Encoding': 'gzip'})
    assert resp.headers.get('Content-Encoding') == 'gzip'
    assert (await resp.json())['x'] == 'y' * 5000
