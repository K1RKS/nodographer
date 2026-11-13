"""
meshinfo snapshot publishing.

Every successful scan is written to a fresh directory under
<dataDir>/snapshots/ and then <dataDir>/current is atomically re-pointed at
it, so readers (the API service, a web server, rsync) always see one complete,
self-consistent scan. A scan that is still running, fails, or is rejected never
touches the published snapshot.

<dataDir>/status.json is rewritten atomically at the start and end of each
cycle so readers can tell whether a scan is in progress and when the last one
succeeded.
"""

import hashlib
import json
import logging
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Union

SCHEMA_VERSION = 2
SNAPSHOT_FILES = (
    'map_data.json',
    'node_report_data.json',
    'nodes.kml',
    'nodes.csv',
    'nodes.json',
)
MANIFEST = 'manifest.json'
STATUS = 'status.json'
CURRENT = 'current'
SNAPSHOTS = 'snapshots'
TMP_PREFIX = '.tmp-'


class PublishRejected(Exception):
    """The snapshot failed a sanity check and was not published."""


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).strftime('%Y-%m-%dT%H:%M:%SZ')


def _fsync_dir(path: Path) -> None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _write_file(path: Path, data: bytes) -> None:
    with open(path, 'wb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(path, 0o644)


def atomic_write(path: Path, data: Union[str, bytes]) -> None:
    """Write via a temp file in the same directory and rename over the target."""
    if isinstance(data, str):
        data = data.encode('utf-8')
    tmp = path.with_name(f'.{path.name}.tmp')
    try:
        _write_file(tmp, data)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        with open(path, 'r', encoding='utf-8') as f:
            value = json.load(f)
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def current_snapshot_dir(data_dir: Union[str, Path]) -> Optional[Path]:
    """Resolve <dataDir>/current to its snapshot directory, or None if nothing is published."""
    link = Path(data_dir) / CURRENT
    try:
        target = link.resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    return target if target.is_dir() else None


class SnapshotPublisher:
    def __init__(self, data_dir: Union[str, Path], keep: int = 3, min_node_ratio: float = 0.5,
                 logger: Optional[logging.Logger] = None):
        self.data_dir = Path(data_dir)
        self.snapshots_dir = self.data_dir / SNAPSHOTS
        self.current_link = self.data_dir / CURRENT
        self.status_path = self.data_dir / STATUS
        self.keep = max(int(keep), 2)
        self.min_node_ratio = max(float(min_node_ratio), 0.0)
        self.logger = logger or logging.getLogger('meshinfo.publisher')

    # ----- reading -----

    def current_dir(self) -> Optional[Path]:
        return current_snapshot_dir(self.data_dir)

    def current_manifest(self) -> Optional[Dict[str, Any]]:
        snap = self.current_dir()
        return read_json(snap / MANIFEST) if snap else None

    def read_status(self) -> Dict[str, Any]:
        return read_json(self.status_path) or {}

    # ----- status -----

    def update_status(self, **fields: Any) -> Dict[str, Any]:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        status = self.read_status()
        status.update(fields)
        status['updatedAt'] = iso_utc(utc_now())
        try:
            atomic_write(self.status_path, json.dumps(status, indent=2, sort_keys=True))
        except OSError as e:
            self.logger.error(f"Could not write {self.status_path}: {e}")
        return status

    def start_cycle(self, cycle: int) -> None:
        self.update_status(state='scanning', cycle=cycle, cycleStartedAt=iso_utc(utc_now()))

    def finish_cycle(self, state: str, error: Optional[str] = None,
                     manifest: Optional[Mapping[str, Any]] = None) -> None:
        now = iso_utc(utc_now())
        fields: Dict[str, Any] = {'state': state, 'lastAttemptAt': now, 'lastError': error}
        if manifest:
            fields['lastSuccessAt'] = now
            fields['currentSnapshot'] = manifest.get('snapshotId')
        else:
            current = self.current_manifest()
            fields['currentSnapshot'] = current.get('snapshotId') if current else None
        self.update_status(**fields)

    # ----- publishing -----

    def _snapshot_names(self):
        if not self.snapshots_dir.is_dir():
            return []
        return sorted(p.name for p in self.snapshots_dir.iterdir()
                      if p.is_dir() and not p.name.startswith('.'))

    def new_snapshot_id(self, now: Optional[datetime] = None) -> str:
        """UTC timestamp id that sorts after every existing snapshot (pruning relies on the order)."""
        base = (now or utc_now()).astimezone(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        names = self._snapshot_names()
        if not names or base > names[-1]:
            return base
        # Same second as, or clock behind, the newest snapshot: bump its counter
        latest_base, _, counter = names[-1].partition('-')
        return f'{latest_base}-{int(counter or 0) + 1:03d}'

    def check_node_ratio(self, node_count: int) -> Optional[str]:
        """Return a rejection reason if node_count dropped too far below the published snapshot."""
        if self.min_node_ratio <= 0:
            return None
        previous = self.current_manifest()
        prev_count = int((previous or {}).get('nodeCount') or 0)
        if prev_count <= 0:
            return None
        if node_count < prev_count * self.min_node_ratio:
            return (f"node count {node_count} is below {self.min_node_ratio:.0%} of the "
                    f"published snapshot's {prev_count}")
        return None

    def publish(self, files: Mapping[str, Union[str, bytes]], meta: Optional[Mapping[str, Any]] = None,
                snapshot_id: Optional[str] = None) -> Dict[str, Any]:
        """Write files as a new snapshot and atomically make it current. Returns the manifest."""
        meta = dict(meta or {})
        reason = self.check_node_ratio(int(meta.get('nodeCount') or 0))
        if reason:
            raise PublishRejected(reason)

        self.snapshots_dir.mkdir(parents=True, exist_ok=True)
        snapshot_id = snapshot_id or self.new_snapshot_id()
        final_dir = self.snapshots_dir / snapshot_id
        if final_dir.exists():
            raise FileExistsError(f"snapshot {snapshot_id} already exists")
        tmp_dir = self.snapshots_dir / f'{TMP_PREFIX}{snapshot_id}'
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir)
        tmp_dir.mkdir()
        os.chmod(tmp_dir, 0o755)

        try:
            listing = {}
            for name, content in files.items():
                if '/' in name or name.startswith('.') or name == MANIFEST:
                    raise ValueError(f"invalid snapshot file name: {name!r}")
                data = content.encode('utf-8') if isinstance(content, str) else content
                _write_file(tmp_dir / name, data)
                listing[name] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

            manifest = dict(meta)
            manifest.update({
                'snapshotId': snapshot_id,
                'schemaVersion': SCHEMA_VERSION,
                'publishedAt': iso_utc(utc_now()),
                'files': listing,
            })
            manifest.setdefault('generatedAt', manifest['publishedAt'])
            _write_file(tmp_dir / MANIFEST, json.dumps(manifest, indent=2, sort_keys=True).encode('utf-8'))
            _fsync_dir(tmp_dir)

            os.rename(tmp_dir, final_dir)
            _fsync_dir(self.snapshots_dir)
        except BaseException:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise

        self._swap_current(snapshot_id)
        self.prune()
        self.logger.info(f"Published snapshot {snapshot_id} ({len(listing)} files) -> {self.current_link}")
        return manifest

    def _swap_current(self, snapshot_id: str) -> None:
        tmp_link = self.data_dir / f'.{CURRENT}.tmp'
        if tmp_link.is_symlink() or tmp_link.exists():
            tmp_link.unlink()
        # Relative target so the data dir can be bind-mounted or copied elsewhere
        os.symlink(f'{SNAPSHOTS}/{snapshot_id}', tmp_link)
        os.replace(tmp_link, self.current_link)
        _fsync_dir(self.data_dir)

    def prune(self) -> None:
        if not self.snapshots_dir.is_dir():
            return
        current = self.current_dir()
        snapshots = []
        for entry in self.snapshots_dir.iterdir():
            if entry.name.startswith(TMP_PREFIX):
                # Leftover from a crash mid-publish; publish() runs one at a time
                shutil.rmtree(entry, ignore_errors=True)
            elif entry.is_dir() and not entry.name.startswith('.'):
                snapshots.append(entry)
        snapshots.sort(key=lambda p: p.name, reverse=True)
        for old in snapshots[self.keep:]:
            if current and old.resolve() == current:
                continue
            shutil.rmtree(old, ignore_errors=True)
