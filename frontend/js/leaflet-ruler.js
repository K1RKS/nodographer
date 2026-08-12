(function(factory, window){
  "use strict";
  if (typeof define === 'function' && define.amd) {
    define(['leaflet'], factory);
  } else if (typeof exports === 'object') {
    module.exports = factory(require('leaflet'));
  }
  if (typeof window !== 'undefined' && window.L) {
    window.L.Ruler = factory(L);
  }
}(function (L) {
  "use strict";
  L.Control.Ruler = L.Control.extend({
    options: {
      position: 'topright',
      events: {
        onToggle: function (is_active) { }
      },
      circleMarker: {
        color: 'red',
        radius: 6,
        weight: 2,
        fillOpacity: 1
      },
      lineStyle: {
        color: 'red',
        dashArray: '1,6',
        weight: 3
      },
      lengthUnit: {
        display: 'km',
        decimal: 2,
        factor: null,
        label: 'Distance:'
      },
      angleUnit: {
        display: '&deg;',
        decimal: 2,
        factor: null,
        label: 'Bearing:'
      }
    },
    isActive: function () {
      return this._choice;
    },
    onAdd: function(map) {
      this._map = map;
      this._container = L.DomUtil.create('div', 'leaflet-bar');
      this._container.classList.add('leaflet-ruler');
      //kg6wxc
      this._container.setAttribute('id', 'ruler');

      L.DomEvent.disableClickPropagation(this._container);
      L.DomEvent.disableScrollPropagation(this._container);
      // stopPropagation only — preventDefault on touchstart kills the click on phones
      L.DomEvent.on(this._container, 'mousedown touchstart pointerdown dblclick', this._stopIconBubble, this);
      L.DomEvent.on(this._container, 'click', this._onIconClick, this);
      L.DomEvent.on(this._container, 'touchend', this._onIconTouchEnd, this);
      this._choice = false;
      this._paused = false;
      this._lastIconTouch = 0;
      this._lastTouchMeasure = 0;
      this._defaultCursor = this._map._container.style.cursor;
      this._allLayers = L.layerGroup();
      return this._container;
    },
    onRemove: function() {
      L.DomEvent.off(this._container, 'mousedown touchstart pointerdown dblclick', this._stopIconBubble, this);
      L.DomEvent.off(this._container, 'click', this._onIconClick, this);
      L.DomEvent.off(this._container, 'touchend', this._onIconTouchEnd, this);
      this._unbindMapMeasure();
    },
    _stopIconBubble: function(e) {
      L.DomEvent.stopPropagation(e);
    },
    _onIconTouchEnd: function(e) {
      L.DomEvent.stopPropagation(e);
      L.DomEvent.preventDefault(e);
      this._lastIconTouch = Date.now();
      this._toggleMeasure(e);
    },
    _onIconClick: function(e) {
      if (this._lastIconTouch && Date.now() - this._lastIconTouch < 500) {
        L.DomEvent.stop(e);
        return;
      }
      this._toggleMeasure(e);
    },
    // Icon clicks: start → stop adding (keep lines) → clear and start again.
    // Matches original ESC 1x stop / 2x remove, which phones cannot type.
    _toggleMeasure: function(e) {
      if (e) L.DomEvent.stopPropagation(e);
      if (this._choice) {
        this._pauseMeasure();
      } else if (this._paused) {
        this._clearMeasure();
        this._startMeasure();
      } else {
        this._startMeasure();
      }
      this.options.events.onToggle(this._choice);
    },
    _resetPathState: function() {
      this._clickedLatLong = null;
      this._clickedPoints = [];
      this._totalLength = 0;
      this._clickCount = 0;
      this._movingLatLong = null;
    },
    _startMeasure: function() {
      this._choice = true;
      this._paused = false;
      this._resetPathState();
      this._map.doubleClickZoom.disable();
      L.DomEvent.on(this._map._container, 'keydown', this._escape, this);
      L.DomEvent.on(this._map._container, 'dblclick', this._closePath, this);
      this._container.classList.add("leaflet-ruler-clicked");
      this._container.classList.remove("leaflet-ruler-paused");
      this._tempLine = L.featureGroup().addTo(this._allLayers);
      this._tempPoint = L.featureGroup().addTo(this._allLayers);
      this._pointLayer = L.featureGroup().addTo(this._allLayers);
      this._polylineLayer = L.featureGroup().addTo(this._allLayers);
      this._allLayers.addTo(this._map);
      this._map._container.style.cursor = 'crosshair';
      this._bindMapMeasure();
    },
    _pauseMeasure: function() {
      this._choice = false;
      this._paused = true;
      this._removeTempGuides();
      this._resetPathState();
      this._map.doubleClickZoom.enable();
      L.DomEvent.off(this._map._container, 'keydown', this._escape, this);
      L.DomEvent.off(this._map._container, 'dblclick', this._closePath, this);
      this._container.classList.remove("leaflet-ruler-clicked");
      this._container.classList.add("leaflet-ruler-paused");
      this._map._container.style.cursor = this._defaultCursor;
      this._unbindMapMeasure();
    },
    _clearMeasure: function() {
      this._choice = false;
      this._paused = false;
      this._removeTempGuides();
      this._resetPathState();
      this._map.doubleClickZoom.enable();
      L.DomEvent.off(this._map._container, 'keydown', this._escape, this);
      L.DomEvent.off(this._map._container, 'dblclick', this._closePath, this);
      this._container.classList.remove("leaflet-ruler-clicked");
      this._container.classList.remove("leaflet-ruler-paused");
      if (this._map.hasLayer(this._allLayers)) {
        this._map.removeLayer(this._allLayers);
      }
      this._allLayers = L.layerGroup();
      this._map._container.style.cursor = this._defaultCursor;
      this._unbindMapMeasure();
    },
    _bindMapMeasure: function() {
      this._map.on('click', this._clicked, this);
      this._map.on('mousemove', this._moving, this);
      L.DomEvent.on(this._map._container, 'touchend', this._onMapTouchEnd, this);
    },
    _unbindMapMeasure: function() {
      this._map.off('click', this._clicked, this);
      this._map.off('mousemove', this._moving, this);
      L.DomEvent.off(this._map._container, 'touchend', this._onMapTouchEnd, this);
    },
    _onMapTouchEnd: function(e) {
      if (!this._choice) return;
      if (this._eventFromRuler(e)) return;
      var t = e.changedTouches && e.changedTouches[0];
      if (!t || !this._map.mouseEventToLatLng) return;
      var latlng = this._map.mouseEventToLatLng(t);
      this._lastTouchMeasure = Date.now();
      this._clicked({ latlng: latlng, originalEvent: e });
    },
    _removeTempGuides: function() {
      if (this._tempLine && this._map.hasLayer(this._tempLine)) {
        this._map.removeLayer(this._tempLine);
      }
      if (this._tempPoint && this._map.hasLayer(this._tempPoint)) {
        this._map.removeLayer(this._tempPoint);
      }
    },
    _eventFromRuler: function(e) {
      var oe = e && (e.originalEvent || e);
      if (!oe) return false;
      var t = oe.target || oe.srcElement;
      if (t && t.closest && t.closest('#ruler, .leaflet-ruler')) return true;
      var x = oe.clientX;
      var y = oe.clientY;
      if ((x == null || y == null) && oe.changedTouches && oe.changedTouches[0]) {
        x = oe.changedTouches[0].clientX;
        y = oe.changedTouches[0].clientY;
      }
      if (x == null || y == null || !this._container.getBoundingClientRect) return false;
      var r = this._container.getBoundingClientRect();
      var pad = 10;
      return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
    },
    _clicked: function(e) {
      if (!e || !e.latlng) return;
      if (this._eventFromRuler(e)) return;
      if (e.originalEvent && e.originalEvent.type === 'click' &&
          this._lastTouchMeasure && Date.now() - this._lastTouchMeasure < 500) {
        return;
      }

      var prev = this._clickedLatLong;
      // Touch devices often have no mousemove; compute segment from last point → tap
      if (prev) {
        this._movingLatLong = e.latlng;
        this._calculateBearingAndDistance();
      }

      L.circleMarker(e.latlng, this.options.circleMarker).addTo(this._pointLayer);

      if (this._clickCount > 0 && prev && !e.latlng.equals(prev) && this._result) {
        L.polyline([prev, e.latlng], this.options.lineStyle).addTo(this._polylineLayer);
        this._totalLength += this._result.Distance;
        var text;
        if (this._clickCount > 1) {
          text = '<b>' + this.options.angleUnit.label + '</b>&nbsp;' + this._result.Bearing.toFixed(this.options.angleUnit.decimal) + '&nbsp;' + this.options.angleUnit.display + '<br><b>' + this.options.lengthUnit.label + '</b>&nbsp;' + this._totalLength.toFixed(this.options.lengthUnit.decimal) + '&nbsp;' +  this.options.lengthUnit.display;
        } else {
          text = '<b>' + this.options.angleUnit.label + '</b>&nbsp;' + this._result.Bearing.toFixed(this.options.angleUnit.decimal) + '&nbsp;' + this.options.angleUnit.display + '<br><b>' + this.options.lengthUnit.label + '</b>&nbsp;' + this._result.Distance.toFixed(this.options.lengthUnit.decimal) + '&nbsp;' +  this.options.lengthUnit.display;
        }
        L.circleMarker(e.latlng, this.options.circleMarker).bindTooltip(text, {permanent: true, className: 'result-tooltip'}).addTo(this._pointLayer).openTooltip();
      }

      this._clickedLatLong = e.latlng;
      this._clickedPoints.push(e.latlng);
      this._clickCount++;
    },
    _moving: function(e) {
      if (this._clickedLatLong){
        this._movingLatLong = e.latlng;
        if (this._tempLine){
          this._map.removeLayer(this._tempLine);
          this._map.removeLayer(this._tempPoint);
        }
        var text;
        this._addedLength = 0;
        this._tempLine = L.featureGroup();
        this._tempPoint = L.featureGroup();
        this._tempLine.addTo(this._map);
        this._tempPoint.addTo(this._map);
        this._calculateBearingAndDistance();
        this._addedLength = this._result.Distance + this._totalLength;
        L.polyline([this._clickedLatLong, this._movingLatLong], this.options.lineStyle).addTo(this._tempLine);
        if (this._clickCount > 1){
          text = '<b>' + this.options.angleUnit.label + '</b>&nbsp;' + this._result.Bearing.toFixed(this.options.angleUnit.decimal) + '&nbsp;' + this.options.angleUnit.display + '<br><b>' + this.options.lengthUnit.label + '</b>&nbsp;' + this._addedLength.toFixed(this.options.lengthUnit.decimal) + '&nbsp;' +  this.options.lengthUnit.display + '<br><div class="plus-length">(+' + this._result.Distance.toFixed(this.options.lengthUnit.decimal) + ')</div>';
        }
        else {
          text = '<b>' + this.options.angleUnit.label + '</b>&nbsp;' + this._result.Bearing.toFixed(this.options.angleUnit.decimal) + '&nbsp;' + this.options.angleUnit.display + '<br><b>' + this.options.lengthUnit.label + '</b>&nbsp;' + this._result.Distance.toFixed(this.options.lengthUnit.decimal) + '&nbsp;' +  this.options.lengthUnit.display;
        }
        L.circleMarker(this._movingLatLong, this.options.circleMarker).bindTooltip(text, {sticky: true, offset: L.point(0, -40) ,className: 'moving-tooltip'}).addTo(this._tempPoint).openTooltip();
      }
    },
    _escape: function(e) {
      if (e.keyCode === 27){
        if (this._clickCount > 0){
          this._closePath();
        }
        else if (this._choice) {
          this._pauseMeasure();
          this.options.events.onToggle(this._choice);
        }
        else {
          this._clearMeasure();
          this.options.events.onToggle(this._choice);
        }
      }
    },
    _calculateBearingAndDistance: function() {
      var f1 = this._clickedLatLong.lat, l1 = this._clickedLatLong.lng, f2 = this._movingLatLong.lat, l2 = this._movingLatLong.lng;
      var toRadian = Math.PI / 180;
      // haversine formula
      // bearing
      var y = Math.sin((l2-l1)*toRadian) * Math.cos(f2*toRadian);
      var x = Math.cos(f1*toRadian)*Math.sin(f2*toRadian) - Math.sin(f1*toRadian)*Math.cos(f2*toRadian)*Math.cos((l2-l1)*toRadian);
      var brng = Math.atan2(y, x)*((this.options.angleUnit.factor ? this.options.angleUnit.factor/2 : 180)/Math.PI);
      brng += brng < 0 ? (this.options.angleUnit.factor ? this.options.angleUnit.factor : 360) : 0;
      // distance
      var R = this.options.lengthUnit.factor ? 6371 * this.options.lengthUnit.factor : 6371; // kilometres
      var deltaF = (f2 - f1)*toRadian;
      var deltaL = (l2 - l1)*toRadian;
      var a = Math.sin(deltaF/2) * Math.sin(deltaF/2) + Math.cos(f1*toRadian) * Math.cos(f2*toRadian) * Math.sin(deltaL/2) * Math.sin(deltaL/2);
      var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      var distance = R * c;
      this._result = {
        Bearing: brng,
        Distance: distance
      };
    },
    _closePath: function() {
      this._removeTempGuides();
      if (this._clickCount <= 1 && this._pointLayer && this._map.hasLayer(this._pointLayer)) {
        this._map.removeLayer(this._pointLayer);
      }
      this._resetPathState();
    }
  });
  L.control.ruler = function(options) {
    return new L.Control.Ruler(options);
  };
}, window));
