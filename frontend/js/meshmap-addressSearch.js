/**
 * Meshmap (== Nodographer frontend) address search.
 * Geocodes a typed address, centers the map on it, and drops a marker.
 * Markers accumulate, persist for the tab session (survive the page's
 * auto-refresh), and have a right-click / long-press menu.
 */
(function (window) {
  var DEFAULT_GEOCODER_URL = 'https://nominatim.openstreetmap.org/search';
  var RESULT_LIMIT = 5;
  var RESULT_ZOOM = 17;
  var FETCH_TIMEOUT_MS = 10000;
  var SESSION_KEY = 'addressMarkers';

  var SEARCH_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
    '<path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/>' +
    '</svg>';

  var map = null;
  var geocoderUrl = DEFAULT_GEOCODER_URL;
  var markerLayer = null;
  var entries = [];
  var menuEl = null;
  var toastEl = null;
  var toastTimer = null;
  var addressIcon = null;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtCoord(n) {
    return Number(n).toFixed(6);
  }

  // ----- Session persistence -----

  function saveSession() {
    if (!window.MeshmapSession) return;
    MeshmapSession.write({
      addressMarkers: entries.map(function (e) {
        return { lat: e.lat, lon: e.lon, label: e.label };
      }),
    });
  }

  function restoreSession() {
    if (!window.MeshmapSession) return;
    var s = MeshmapSession.read();
    var list = s && Array.isArray(s[SESSION_KEY]) ? s[SESSION_KEY] : [];
    list.forEach(function (item) {
      var lat = parseFloat(item && item.lat);
      var lon = parseFloat(item && item.lon);
      if (isNaN(lat) || isNaN(lon)) return;
      addMarker(lat, lon, item.label || '', { save: false });
    });
  }

  // ----- Markers -----

  function addMarker(lat, lon, label, opts) {
    opts = opts || {};
    var marker = L.marker([lat, lon], {
      icon: addressIcon,
      title: label,
      alt: label || 'Address marker',
      riseOnHover: true,
    });
    var entry = { lat: lat, lon: lon, label: label, marker: marker };

    marker.bindPopup(
      '<div class="meshmap-addr-popup">' +
        '<div class="meshmap-addr-popup-label">' + escapeHtml(label || 'Address') + '</div>' +
        '<div class="meshmap-addr-popup-coords">' + fmtCoord(lat) + ', ' + fmtCoord(lon) + '</div>' +
        '<div class="meshmap-addr-popup-hint">Right-click (long-press on touch) for options</div>' +
      '</div>'
    );

    marker.on('contextmenu', function (e) {
      if (e.originalEvent) L.DomEvent.preventDefault(e.originalEvent);
      marker.closePopup();
      openMenu(entry, e.containerPoint || map.latLngToContainerPoint(marker.getLatLng()));
    });

    marker.addTo(markerLayer);
    entries.push(entry);
    if (opts.save !== false) saveSession();
    return entry;
  }

  function removeEntry(entry) {
    markerLayer.removeLayer(entry.marker);
    entries = entries.filter(function (e) {
      return e !== entry;
    });
    saveSession();
  }

  // ----- Context menu -----

  function closeMenu() {
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null;
  }

  function openMenu(entry, point) {
    closeMenu();
    var container = map.getContainer();
    menuEl = L.DomUtil.create('div', 'meshmap-addr-menu', container);
    menuEl.setAttribute('role', 'menu');
    L.DomEvent.disableClickPropagation(menuEl);
    L.DomEvent.disableScrollPropagation(menuEl);
    L.DomEvent.on(menuEl, 'contextmenu', L.DomEvent.preventDefault);

    var latlng = L.latLng(entry.lat, entry.lon);
    var coordText = fmtCoord(entry.lat) + ', ' + fmtCoord(entry.lon);
    var items = [
      { text: 'Center map here', action: function () { map.panTo(latlng); } },
      { text: 'Copy coordinates', action: function () { copyText(coordText); } },
      { text: 'Copy address', disabled: !entry.label, action: function () { copyText(entry.label); } },
      {
        text: 'Open in OpenStreetMap',
        action: function () {
          window.open(
            'https://www.openstreetmap.org/?mlat=' + entry.lat + '&mlon=' + entry.lon +
              '#map=' + RESULT_ZOOM + '/' + entry.lat + '/' + entry.lon,
            '_blank',
            'noopener'
          );
        },
      },
      {
        text: 'Open in Google Maps',
        action: function () {
          window.open('https://www.google.com/maps?q=' + entry.lat + ',' + entry.lon, '_blank', 'noopener');
        },
      },
      { separator: true },
      { text: 'Remove marker', danger: true, action: function () { removeEntry(entry); } },
    ];

    var header = L.DomUtil.create('div', 'meshmap-addr-menu-header', menuEl);
    header.textContent = entry.label || coordText;
    header.title = entry.label || coordText;

    items.forEach(function (item) {
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
        closeMenu();
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

  // ----- Clipboard + toast -----

  function showToast(text) {
    if (!toastEl) {
      toastEl = L.DomUtil.create('div', 'meshmap-addr-toast', map.getContainer());
    }
    toastEl.textContent = text;
    toastEl.classList.add('meshmap-addr-toast-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('meshmap-addr-toast-visible');
    }, 1600);
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  function copyText(text) {
    // execCommand must run synchronously inside the click gesture, and the
    // Clipboard API is unavailable on plain-HTTP mesh pages, so try it first
    if (legacyCopy(text)) {
      showToast('Copied');
      return;
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(
        function () { showToast('Copied'); },
        function () { showToast('Copy failed: ' + text); }
      );
      return;
    }
    showToast('Copy failed: ' + text);
  }

  // ----- Geocoding -----

  function buildQueryUrl(query) {
    var params = [
      'format=jsonv2',
      'limit=' + RESULT_LIMIT,
      'q=' + encodeURIComponent(query),
    ];
    // Prefer results near the current view without excluding others
    try {
      var b = map.getBounds();
      params.push(
        'viewbox=' +
          [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()]
            .map(function (n) { return n.toFixed(5); })
            .join(',')
      );
      params.push('bounded=0');
    } catch (e) {}
    return geocoderUrl + (geocoderUrl.indexOf('?') === -1 ? '?' : '&') + params.join('&');
  }

  function geocode(query) {
    var controller = window.AbortController ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS) : null;
    return fetch(buildQueryUrl(query), {
      headers: { Accept: 'application/json' },
      signal: controller ? controller.signal : undefined,
    })
      .then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function (data) {
        if (!Array.isArray(data)) return [];
        return data
          .map(function (r) {
            return {
              lat: parseFloat(r.lat),
              lon: parseFloat(r.lon),
              label: r.display_name || query,
            };
          })
          .filter(function (r) {
            return !isNaN(r.lat) && !isNaN(r.lon);
          });
      })
      .finally(function () {
        if (timer) clearTimeout(timer);
      });
  }

  // ----- Control -----

  var AddressSearchControl = L.Control.extend({
    options: { position: 'verticalcenterleft' },

    onAdd: function () {
      var self = this;
      var container = L.DomUtil.create('div', 'leaflet-bar leaflet-control meshmap-addr-search');
      container.title = 'Search for an address';

      var button = L.DomUtil.create('a', 'meshmap-addr-search-button', container);
      button.href = '#';
      button.setAttribute('role', 'button');
      button.setAttribute('aria-label', 'Search for an address');
      button.innerHTML = SEARCH_SVG;

      var panel = L.DomUtil.create('div', 'meshmap-addr-search-panel', container);
      var form = L.DomUtil.create('form', 'meshmap-addr-search-form', panel);
      var input = L.DomUtil.create('input', 'meshmap-addr-search-input', form);
      input.type = 'search';
      input.placeholder = 'Search address...';
      input.setAttribute('aria-label', 'Address');
      input.autocomplete = 'off';
      var message = L.DomUtil.create('div', 'meshmap-addr-search-message', panel);
      var results = L.DomUtil.create('ul', 'meshmap-addr-search-results', panel);

      this._container = container;
      this._input = input;
      this._message = message;
      this._results = results;
      this._busy = false;

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);

      L.DomEvent.on(button, 'click', function (ev) {
        L.DomEvent.preventDefault(ev);
        if (self.isExpanded()) self.collapse();
        else self.expand();
      });

      L.DomEvent.on(form, 'submit', function (ev) {
        L.DomEvent.preventDefault(ev);
        self.search(input.value);
      });

      L.DomEvent.on(input, 'keydown', function (ev) {
        if (ev.key === 'Escape') {
          L.DomEvent.stop(ev);
          self.collapse();
        } else if (ev.key === 'Enter') {
          L.DomEvent.stop(ev);
          self.search(input.value);
        }
      });

      return container;
    },

    isExpanded: function () {
      return L.DomUtil.hasClass(this._container, 'meshmap-addr-search-expanded');
    },

    expand: function () {
      L.DomUtil.addClass(this._container, 'meshmap-addr-search-expanded');
      this._input.focus();
      this._input.select();
    },

    collapse: function () {
      L.DomUtil.removeClass(this._container, 'meshmap-addr-search-expanded');
      this._clearResults();
      this._setMessage('');
      this._input.blur();
    },

    _setMessage: function (text, isError) {
      this._message.textContent = text || '';
      L.DomUtil[isError ? 'addClass' : 'removeClass'](this._message, 'meshmap-addr-search-error');
    },

    _clearResults: function () {
      this._results.innerHTML = '';
    },

    _place: function (r) {
      addMarker(r.lat, r.lon, r.label);
      map.setView([r.lat, r.lon], Math.max(map.getZoom(), RESULT_ZOOM));
      this.collapse();
    },

    _showResults: function (list) {
      var self = this;
      this._clearResults();
      list.forEach(function (r) {
        var li = L.DomUtil.create('li', 'meshmap-addr-search-result', self._results);
        li.textContent = r.label;
        li.title = r.label;
        li.tabIndex = 0;
        L.DomEvent.on(li, 'click', function (ev) {
          L.DomEvent.stop(ev);
          self._place(r);
        });
        L.DomEvent.on(li, 'keydown', function (ev) {
          if (ev.key === 'Enter') {
            L.DomEvent.stop(ev);
            self._place(r);
          }
        });
      });
    },

    search: function (raw) {
      var self = this;
      var query = (raw || '').trim();
      if (!query || this._busy) return;
      this._busy = true;
      this._clearResults();
      this._setMessage('Searching...');
      geocode(query)
        .then(function (list) {
          if (!list.length) {
            self._setMessage('No match for "' + query + '"', true);
            return;
          }
          if (list.length === 1) {
            self._place(list[0]);
            return;
          }
          self._setMessage('Pick a result:');
          self._showResults(list);
        })
        .catch(function (err) {
          console.warn('address search failed', err);
          self._setMessage('Address lookup unavailable (no internet access?)', true);
        })
        .finally(function () {
          self._busy = false;
        });
    },
  });

  function init(leafletMap, mapInfo) {
    if (!leafletMap || !window.L) return;
    map = leafletMap;
    if (mapInfo && typeof mapInfo.geocoderUrl === 'string' && mapInfo.geocoderUrl) {
      geocoderUrl = mapInfo.geocoderUrl;
    }

    addressIcon = L.icon({
      iconUrl: 'images/mapMarkers/Red_Marker.png',
      iconSize: [36, 36],
      iconAnchor: [18, 35],
      popupAnchor: [0, -32],
      className: 'meshmap-addr-marker',
    });

    markerLayer = L.layerGroup().addTo(map);
    var control = new AddressSearchControl().addTo(map);

    map.on('click', function () {
      closeMenu();
      if (control.isExpanded()) control.collapse();
    });
    map.on('movestart zoomstart', closeMenu);
    L.DomEvent.on(document, 'keydown', function (ev) {
      if (ev.key === 'Escape') closeMenu();
    });

    restoreSession();
  }

  window.MeshmapAddressSearch = {
    init: init,
    addMarker: function (lat, lon, label) {
      return map ? addMarker(lat, lon, label || '') : null;
    },
  };
})(window);
