/**
 * Meshmap (== Nodographer frontend) marker context menu.
 * Shared right-click / long-press menu for address and node markers, plus the
 * glue that lets markers start, extend, and end the ruler.
 */
(function (window) {
  var map = null;
  var ruler = null;
  var oms = null;
  var menuEl = null;

  function init(leafletMap) {
    if (map || !leafletMap) return;
    map = leafletMap;
    map.on('click', close);
    map.on('movestart zoomstart', close);
    L.DomEvent.on(document, 'keydown', function (ev) {
      if (ev.key === 'Escape') close();
    });
  }

  function close() {
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null;
  }

  /**
   * items: [{ text, action, disabled, danger } | { separator: true }]
   */
  function open(point, header, items) {
    if (!map) return;
    close();
    menuEl = L.DomUtil.create('div', 'meshmap-addr-menu', map.getContainer());
    menuEl.setAttribute('role', 'menu');
    L.DomEvent.disableClickPropagation(menuEl);
    L.DomEvent.disableScrollPropagation(menuEl);
    L.DomEvent.on(menuEl, 'contextmenu', L.DomEvent.preventDefault);

    if (header) {
      var headerEl = L.DomUtil.create('div', 'meshmap-addr-menu-header', menuEl);
      headerEl.textContent = header;
      headerEl.title = header;
    }

    items.forEach(function (item) {
      if (!item) return;
      if (item.separator) {
        L.DomUtil.create('div', 'meshmap-addr-menu-sep', menuEl);
        return;
      }
      var btn = L.DomUtil.create(
        'button',
        'meshmap-addr-menu-item' + (item.danger ? ' meshmap-addr-menu-danger' : ''),
        menuEl
      );
      btn.type = 'button';
      btn.setAttribute('role', 'menuitem');
      btn.textContent = item.text;
      if (item.disabled) {
        btn.disabled = true;
        return;
      }
      L.DomEvent.on(btn, 'click', function (ev) {
        L.DomEvent.stop(ev);
        close();
        item.action();
      });
    });

    // Keep the menu inside the map viewport
    var size = map.getSize();
    var w = menuEl.offsetWidth;
    var h = menuEl.offsetHeight;
    var x = Math.max(4, Math.min(point.x, size.x - w - 4));
    var y = Math.max(4, Math.min(point.y, size.y - h - 4));
    menuEl.style.left = x + 'px';
    menuEl.style.top = y + 'px';
  }

  // ----- Ruler -----

  function setRuler(control) {
    ruler = control || null;
  }

  function isMeasuring() {
    return !!(ruler && ruler.isMeasuring && ruler.isMeasuring());
  }

  function rulerItem(latlng) {
    if (!ruler || !ruler.startAt) return null;
    if (isMeasuring() && ruler.pointCount() > 0) {
      return { text: 'End ruler here', action: function () { ruler.endAt(latlng); } };
    }
    return { text: 'Start ruler here', action: function () { ruler.startAt(latlng); } };
  }

  /**
   * Left click on a marker: add a snapped ruler point while measuring,
   * otherwise toggle the marker's popup as Leaflet normally would.
   */
  function handleMarkerClick(marker, latlng, e) {
    if (isMeasuring()) {
      if (e && e.originalEvent) L.DomEvent.stop(e.originalEvent);
      marker.closePopup();
      ruler.addPoint(latlng);
      return;
    }
    if (marker._openPopup) marker._openPopup(e);
    else marker.openPopup();
  }

  /**
   * Leaflet's built-in popup click handler is swapped for handleMarkerClick
   * so the popup stays closed while measuring.
   */
  function takeOverPopupClick(marker, getLatLng) {
    if (marker._openPopup) marker.off('click', marker._openPopup, marker);
    marker.on('click', function (e) {
      handleMarkerClick(marker, getLatLng(), e);
    });
  }

  function contextPoint(e, latlng) {
    return e.containerPoint || map.latLngToContainerPoint(latlng);
  }

  // ----- Node markers -----

  // Spiderfied markers are moved to their fan-out position; snap to the real one
  function nodeLatLng(marker) {
    var data = oms && oms.data && oms.data[marker._leaflet_id];
    return data && data.usualPosition ? data.usualPosition : marker.getLatLng();
  }

  function attachNodeMarkers(markers, spiderfier) {
    oms = spiderfier || oms;
    (markers || []).forEach(function (marker) {
      if (marker._meshmapMenuAttached) return;
      marker._meshmapMenuAttached = true;
      takeOverPopupClick(marker, function () { return nodeLatLng(marker); });
      marker.on('contextmenu', function (e) {
        if (e.originalEvent) L.DomEvent.preventDefault(e.originalEvent);
        marker.closePopup();
        var latlng = nodeLatLng(marker);
        var item = rulerItem(latlng);
        if (!item) return;
        open(contextPoint(e, marker.getLatLng()), marker.options.title || '', [item]);
      });
    });
  }

  window.MeshmapMarkerMenu = {
    init: init,
    open: open,
    close: close,
    setRuler: setRuler,
    isMeasuring: isMeasuring,
    rulerItem: rulerItem,
    handleMarkerClick: handleMarkerClick,
    takeOverPopupClick: takeOverPopupClick,
    attachNodeMarkers: attachNodeMarkers,
  };
})(window);
