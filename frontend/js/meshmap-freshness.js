/**
 * Meshmap (== Nodographer frontend) data-freshness label.
 * Shows the most recent node last_seen near the bottom of the map
 * so operators can tell whether backend polling is staying current.
 */
(function (window) {
  function parseTs(iso) {
    if (typeof window.parseUTCTimestamp === 'function') {
      var d = window.parseUTCTimestamp(iso);
      return d instanceof Date && !isNaN(d.getTime()) ? d : null;
    }
    if (!iso || typeof iso !== 'string') return null;
    var normalized = iso.replace(' ', 'T');
    if (normalized.slice(-1) !== 'Z') normalized += 'Z';
    var parsed = new Date(normalized);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  function newestLastSeen(allDevices) {
    var newest = null;
    if (!allDevices || typeof allDevices !== 'object') return null;
    Object.keys(allDevices).forEach(function (band) {
      var list = allDevices[band];
      if (!Array.isArray(list)) return;
      list.forEach(function (device) {
        if (!device || !device.last_seen) return;
        var t = parseTs(device.last_seen);
        if (!t) return;
        if (!newest || t > newest) newest = t;
      });
    });
    return newest;
  }

  function addToMap(map, allDevices) {
    if (!map) return null;
    var newest = newestLastSeen(allDevices);
    if (!newest) return null;
    var label = 'Newest node last seen: ' + newest.toLocaleString();
    if (map.attributionControl) {
      map.attributionControl.addAttribution(label);
    } else if (window.L) {
      var ctrl = L.control({ position: 'bottomleft' });
      ctrl.onAdd = function () {
        var div = L.DomUtil.create('div', 'leaflet-control-attribution meshmap-freshness');
        div.textContent = label;
        return div;
      };
      ctrl.addTo(map);
    }
    return newest;
  }

  window.MeshmapFreshness = {
    newestLastSeen: newestLastSeen,
    addToMap: addToMap
  };
})(window);
