import json
import os

import pytest

from publisher import CURRENT, MANIFEST, PublishRejected, SnapshotPublisher, current_snapshot_dir


def files(n=1):
    return {
        'map_data.json': json.dumps({'mapInfo': {'n': n}}),
        'node_report_data.json': '[]',
        'nodes.kml': '<kml/>',
    }


def test_publish_creates_snapshot_and_current_link(tmp_path):
    pub = SnapshotPublisher(tmp_path)
    manifest = pub.publish(files(), {'nodeCount': 5})

    link = tmp_path / CURRENT
    assert link.is_symlink()
    assert not os.path.isabs(os.readlink(link))
    snap = current_snapshot_dir(tmp_path)
    assert snap.name == manifest['snapshotId']
    assert json.loads((snap / 'map_data.json').read_text()) == {'mapInfo': {'n': 1}}
    on_disk = json.loads((snap / MANIFEST).read_text())
    assert on_disk['nodeCount'] == 5
    assert set(on_disk['files']) == set(files())
    assert all(len(f['sha256']) == 64 for f in on_disk['files'].values())
    assert not list((tmp_path / 'snapshots').glob('.tmp-*'))


def test_swap_points_current_at_newest(tmp_path):
    pub = SnapshotPublisher(tmp_path)
    first = pub.publish(files(1), {'nodeCount': 5})
    second = pub.publish(files(2), {'nodeCount': 5})
    assert first['snapshotId'] != second['snapshotId']
    snap = current_snapshot_dir(tmp_path)
    assert snap.name == second['snapshotId']
    assert json.loads((snap / 'map_data.json').read_text())['mapInfo']['n'] == 2


def test_open_file_from_old_snapshot_survives_swap(tmp_path):
    pub = SnapshotPublisher(tmp_path)
    pub.publish(files(1), {'nodeCount': 5})
    with open(current_snapshot_dir(tmp_path) / 'map_data.json') as reader:
        pub.publish(files(2), {'nodeCount': 5})
        assert json.load(reader)['mapInfo']['n'] == 1


def test_prune_keeps_n_snapshots(tmp_path):
    pub = SnapshotPublisher(tmp_path, keep=2)
    ids = [pub.publish(files(i), {'nodeCount': 5})['snapshotId'] for i in range(4)]
    remaining = sorted(p.name for p in (tmp_path / 'snapshots').iterdir())
    assert remaining == sorted(ids[-2:])
    assert current_snapshot_dir(tmp_path).name == ids[-1]


def test_keep_never_below_two(tmp_path):
    assert SnapshotPublisher(tmp_path, keep=1).keep == 2


def test_min_node_ratio_rejects_and_keeps_current(tmp_path):
    pub = SnapshotPublisher(tmp_path, min_node_ratio=0.5)
    good = pub.publish(files(1), {'nodeCount': 100})
    with pytest.raises(PublishRejected):
        pub.publish(files(2), {'nodeCount': 40})
    assert current_snapshot_dir(tmp_path).name == good['snapshotId']
    assert len(list((tmp_path / 'snapshots').iterdir())) == 1
    pub.publish(files(3), {'nodeCount': 60})


def test_min_node_ratio_disabled(tmp_path):
    pub = SnapshotPublisher(tmp_path, min_node_ratio=0)
    pub.publish(files(1), {'nodeCount': 100})
    pub.publish(files(2), {'nodeCount': 1})


def test_failed_write_leaves_current_untouched(tmp_path):
    pub = SnapshotPublisher(tmp_path)
    good = pub.publish(files(1), {'nodeCount': 5})
    with pytest.raises(ValueError):
        pub.publish({'map_data.json': '{}', '../escape.json': '{}'}, {'nodeCount': 5})
    assert current_snapshot_dir(tmp_path).name == good['snapshotId']
    assert not list((tmp_path / 'snapshots').glob('.tmp-*'))


def test_prune_removes_stale_tmp_dirs(tmp_path):
    pub = SnapshotPublisher(tmp_path)
    stale = tmp_path / 'snapshots' / '.tmp-crashed'
    stale.mkdir(parents=True)
    pub.publish(files(), {'nodeCount': 1})
    assert not stale.exists()


def test_status_lifecycle(tmp_path):
    pub = SnapshotPublisher(tmp_path)
    pub.start_cycle(1)
    assert pub.read_status()['state'] == 'scanning'

    manifest = pub.publish(files(), {'nodeCount': 1})
    pub.finish_cycle('idle', manifest=manifest)
    status = pub.read_status()
    assert status['state'] == 'idle'
    assert status['currentSnapshot'] == manifest['snapshotId']
    assert status['lastSuccessAt'] == status['lastAttemptAt']

    pub.start_cycle(2)
    pub.finish_cycle('failed', error='boom')
    status = pub.read_status()
    assert status['state'] == 'failed'
    assert status['lastError'] == 'boom'
    assert status['currentSnapshot'] == manifest['snapshotId']
    assert status['cycle'] == 2


def test_no_snapshot_yet(tmp_path):
    pub = SnapshotPublisher(tmp_path)
    assert pub.current_dir() is None
    assert pub.current_manifest() is None
    assert pub.check_node_ratio(0) is None
