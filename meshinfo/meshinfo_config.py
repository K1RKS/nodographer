"""
meshinfo configuration loading, shared by the poller and the API service.
"""

import sys
from pathlib import Path
from typing import Any, Dict, Optional

try:
    import tomllib as tomli  # Python 3.11+
except ImportError:  # pragma: no cover
    import tomli

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = SCRIPT_DIR / 'meshinfo.toml'
LEGACY_CONFIG = SCRIPT_DIR.parent / 'settings.toml'
DEFAULT_DATA_DIR = '/var/lib/meshinfo'


def resolve_config_path(explicit: Optional[str] = None) -> Path:
    """Explicit --config, else meshinfo/meshinfo.toml, else the legacy ../settings.toml."""
    if explicit:
        return Path(explicit)
    if DEFAULT_CONFIG.exists():
        return DEFAULT_CONFIG
    if LEGACY_CONFIG.exists():
        print(
            f"WARNING: {DEFAULT_CONFIG} not found; using legacy {LEGACY_CONFIG}. "
            "Run meshinfo/tools/migrate_settings.py to split it into meshinfo.toml "
            "and frontend/config/nodographer.json.",
            file=sys.stderr,
        )
        return LEGACY_CONFIG
    return DEFAULT_CONFIG


class ConfigManager:
    """Manages configuration loading and validation"""

    def __init__(self, config_path: Optional[str] = None):
        self.config_path = resolve_config_path(config_path)
        self.config = self._load_config()

    def _load_config(self) -> dict:
        """Load configuration from TOML settings file"""
        if not self.config_path.exists():
            raise FileNotFoundError(
                f"\nConfiguration file not found: {self.config_path}\n"
                f"Copy {SCRIPT_DIR / 'meshinfo.example.toml'} to {DEFAULT_CONFIG} and edit it.\n"
            )
        with open(self.config_path, 'rb') as f:
            return tomli.load(f)

    def get(self, section: str, key: str, fallback: Any = None) -> Any:
        """Get configuration value with fallback"""
        try:
            if section not in self.config:
                return fallback
            return self.config[section].get(key, fallback)
        except (KeyError, AttributeError):
            return fallback

    def getint(self, section: str, key: str, fallback: int = 0) -> int:
        """Get integer configuration value"""
        try:
            if section not in self.config:
                return fallback
            value = self.config[section].get(key, fallback)
            return int(value) if value is not None else fallback
        except (KeyError, AttributeError, ValueError):
            return fallback

    def getfloat(self, section: str, key: str, fallback: float = 0.0) -> float:
        """Get float configuration value"""
        try:
            if section not in self.config:
                return fallback
            value = self.config[section].get(key, fallback)
            return float(value) if value is not None else fallback
        except (KeyError, AttributeError, ValueError):
            return fallback

    def get_section(self, section: str) -> Dict[str, Any]:
        """Return an entire configuration section as a dict."""
        value = self.config.get(section, {})
        return value if isinstance(value, dict) else {}

    @property
    def data_dir(self) -> Path:
        return Path(self.get('publish', 'dataDir', DEFAULT_DATA_DIR))
