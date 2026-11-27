import json
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from meshinfo_config import ConfigManager
from meshinfoPoller import MeshPollingDaemon, MySQLAdapter
from publisher import SNAPSHOT_FILES, current_snapshot_dir


class FakeDB:
    def __init__(self, nodes):
        self.nodes = nodes

    async def get_all_nodes(self):
        return [dict(n) for n in self.nodes]

    async def save_polling_stats(self, stats):
        pass

    async def expire_old_hop_sequences(self, days):
        pass

    async def expire_old_nodes(self, days):
        pass


def node(name, ip, lat=44.0, lon=-120.0, channel='149', last_seen=...):
    return {
        'node': name, 'wlan_ip': ip, 'lat': lat, 'lon': lon, 'channel': channel,
        'meshRF': 'on', 'board_id': '0x0', 'firmware_version': 'babel-1.0',
        'last_seen': datetime.now(timezone.utc) if last_seen is ... else last_seen,
        'link_info': '', 'services': 'Not Available',
        'loadavg': '', 'mesh_supernode': 'false',
    }


@pytest.fixture
def daemon(tmp_path):
    cfg = tmp_path / 'meshinfo.toml'
    cfg.write_text(
        f'[publish]\ndataDir = "{tmp_path / "data"}"\nminNodeRatio = 0.5\n'
        f'[retention]\nexpireOldNodes = true\nexpireInterval = 30\n'
    )
    d = MeshPollingDaemon(ConfigManager(str(cfg)))
    d.db = FakeDB([node('n1', '10.0.0.1'), node('n2', '10.0.0.2', channel='none')])
    return d


async def test_publish_snapshot_contents(daemon):
    await daemon._publish_snapshot()
    snap = current_snapshot_dir(daemon.publisher.data_dir)
    assert snap is not None
    for name in SNAPSHOT_FILES:
        assert (snap / name).exists(), name
    map_data = json.loads((snap / 'map_data.json').read_text())
    info = map_data['mapInfo']
    assert info['snapshotId'] == snap.name
    assert info['schemaVersion'] == 2
    assert 'mapTileServers' not in info and 'title' not in info
    assert len(map_data['allDevices']['5ghz']) == 1
    assert len(map_data['allDevices']['noRF']) == 1
    assert len(json.loads((snap / 'node_report_data.json').read_text())) == 2
    assert daemon.publisher.read_status()['state'] == 'idle'


async def test_failed_topology_keeps_current(daemon):
    await daemon._publish_snapshot()
    before = current_snapshot_dir(daemon.publisher.data_dir)

    async def no_topology():
        return None
    daemon._fetch_topology = no_topology
    await daemon._poll_cycle()

    assert current_snapshot_dir(daemon.publisher.data_dir) == before
    status = daemon.publisher.read_status()
    assert status['state'] == 'failed'
    assert status['currentSnapshot'] == before.name


async def test_cycle_exception_marks_failed(daemon):
    await daemon._publish_snapshot()
    before = current_snapshot_dir(daemon.publisher.data_dir)

    async def boom():
        raise RuntimeError('mesh exploded')
    daemon._fetch_topology = boom
    with pytest.raises(RuntimeError):
        await daemon._poll_cycle()

    assert current_snapshot_dir(daemon.publisher.data_dir) == before
    assert daemon.publisher.read_status()['lastError'] == 'mesh exploded'


async def test_node_drop_is_rejected(daemon):
    await daemon._publish_snapshot()
    before = current_snapshot_dir(daemon.publisher.data_dir)
    daemon.db.nodes = []
    await daemon._publish_snapshot()
    assert current_snapshot_dir(daemon.publisher.data_dir) == before
    assert daemon.publisher.read_status()['state'] == 'rejected'


async def test_missed_poll_still_published_until_expire(daemon):
    """Nodes with older last_seen stay in the snapshot until expireInterval."""
    now = datetime.now(timezone.utc)
    daemon.db.nodes = [
        node('fresh', '10.0.0.1', last_seen=now),
        node('missed', '10.0.0.2', last_seen=now - timedelta(days=7)),
        node('expired', '10.0.0.3', last_seen=now - timedelta(days=31)),
        node('never', '10.0.0.4', last_seen=None),
    ]
    # Avoid minNodeRatio rejecting against a prior snapshot
    daemon.publisher.data_dir.mkdir(parents=True, exist_ok=True)
    files, meta = await daemon._build_snapshot_files('testsnap')
    report = json.loads(files['node_report_data.json'])
    names = {n['node'] for n in report}
    assert names == {'fresh', 'missed'}
    assert meta['nodeCount'] == 2


async def test_upsert_topology_node_preserves_last_seen():
    """Topology upsert must assign last_seen = last_seen on conflict."""
    cfg = MagicMock()
    cfg.get = MagicMock(side_effect=lambda *a, **k: a[2] if len(a) > 2 else k.get('default'))
    adapter = MySQLAdapter(cfg)

    cur = AsyncMock()
    conn = MagicMock()
    conn.cursor = MagicMock(return_value=AsyncMock(
        __aenter__=AsyncMock(return_value=cur),
        __aexit__=AsyncMock(return_value=None),
    ))
    pool = MagicMock()
    pool.acquire = MagicMock(return_value=AsyncMock(
        __aenter__=AsyncMock(return_value=conn),
        __aexit__=AsyncMock(return_value=None),
    ))
    adapter.pool = pool

    await adapter.upsert_topology_node('10.1.2.3', 2, 'abcd', node_name='TEST-NODE')

    assert cur.execute.await_count == 1
    sql, params = cur.execute.await_args.args
    assert 'last_seen = last_seen' in sql
    assert 'UTC_TIMESTAMP()' in sql  # set only on INSERT of brand-new rows
    assert params[0] == '10.1.2.3'
    assert params[1] == 'TEST-NODE'
    assert params[2] == 2
