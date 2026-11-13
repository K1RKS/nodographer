import json
from datetime import datetime, timezone

import pytest

from meshinfo_config import ConfigManager
from meshinfoPoller import MeshPollingDaemon
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


def node(name, ip, lat=44.0, lon=-120.0, channel='149'):
    return {
        'node': name, 'wlan_ip': ip, 'lat': lat, 'lon': lon, 'channel': channel,
        'meshRF': 'on', 'board_id': '0x0', 'firmware_version': 'babel-1.0',
        'last_seen': datetime.now(timezone.utc), 'link_info': '', 'services': 'Not Available',
        'loadavg': '', 'mesh_supernode': 'false',
    }


@pytest.fixture
def daemon(tmp_path):
    cfg = tmp_path / 'meshinfo.toml'
    cfg.write_text(f'[publish]\ndataDir = "{tmp_path / "data"}"\nminNodeRatio = 0.5\n')
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
