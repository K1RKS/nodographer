/**
 * Optional deep-link builder for the external SNR Calculator.
 * Enabled when config tools.snrCalculatorUrl is a non-empty absolute URL.
 */
var MeshmapSnrCalculator = (function () {
  'use strict';

  var MAX_NAME_LEN = 48;
  var MAX_COMMENTS_LEN = 2000;
  var deviceByKey = {};

  function nodeKey(name) {
    if (typeof meshmapNodeKey === 'function') {
      return meshmapNodeKey(name);
    }
    return String(name || '').toLowerCase().replace(/\.local\.mesh$/i, '');
  }

  function configuredBaseUrl() {
    var tools = (typeof NodographerConfig !== 'undefined' && NodographerConfig.tools)
      ? NodographerConfig.tools()
      : {};
    var url = tools && typeof tools.snrCalculatorUrl === 'string'
      ? tools.snrCalculatorUrl.trim()
      : '';
    if (!url) {
      return '';
    }
    try {
      var u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return '';
      }
      return u.href.replace(/\/?$/, '/');
    } catch (err) {
      return '';
    }
  }

  function isEnabled() {
    return !!configuredBaseUrl();
  }

  function indexDevices(allDevices) {
    deviceByKey = {};
    if (!allDevices || typeof allDevices !== 'object') {
      return;
    }
    Object.keys(allDevices).forEach(function (band) {
      var arr = allDevices[band];
      if (!arr || !arr.length) {
        return;
      }
      for (var i = 0; i < arr.length; i++) {
        var d = arr[i];
        if (!d || !d.node) {
          continue;
        }
        deviceByKey[nodeKey(d.node)] = d;
      }
    });
  }

  function findDevice(hostname) {
    if (!hostname) {
      return null;
    }
    return deviceByKey[nodeKey(hostname)] || null;
  }

  function num(v) {
    if (v === null || v === undefined || v === '' || v === 'None') {
      return null;
    }
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function sanitizeName(value, fallback) {
    var s = String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .replace(/\s+/g, ' ');
    if (!s) {
      return fallback;
    }
    if (s.length > MAX_NAME_LEN) {
      s = s.slice(0, MAX_NAME_LEN).trim();
    }
    return s || fallback;
  }

  function sanitizeComments(value) {
    var s = String(value == null ? '' : value)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    if (s.length > MAX_COMMENTS_LEN) {
      s = s.slice(0, MAX_COMMENTS_LEN);
    }
    return s;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/`/g, '&#96;');
  }

  function parseBw(v) {
    var n = num(String(v == null ? '' : v).replace(/[^\d.]/g, ''));
    return n !== null && n > 0 ? n : null;
  }

  function frequencyPreset(freqMHz) {
    var f = num(freqMHz);
    if (f === null) {
      return { f: 5800, fp: '5800' };
    }
    var presets = [5800, 2400, 900];
    for (var i = 0; i < presets.length; i++) {
      if (Math.abs(f - presets[i]) < 50) {
        return { f: f, fp: String(presets[i]) };
      }
    }
    return { f: f, fp: 'custom' };
  }

  function antennaTypeFromDesc(desc) {
    var s = String(desc || '').toLowerCase();
    if (!s || s === 'not available') {
      return 'custom';
    }
    if (/\bomni\b/.test(s)) {
      return 'omni';
    }
    if (/\bsector\b/.test(s)) {
      return 'sector';
    }
    if (/\bpanel\b/.test(s)) {
      return 'panel';
    }
    if (/\bdish\b|\bparabolic\b/.test(s)) {
      return 'dish';
    }
    if (/\byagi\b/.test(s)) {
      return 'yagi';
    }
    return 'custom';
  }

  function useKilometers() {
    return !!(typeof mapInfo !== 'undefined' && mapInfo && mapInfo.kilometers);
  }

  var MI_PER_KM = 1 / 1.609344;
  var KM_PER_MI = 1.609344;

  /** Great-circle distance in miles between two lat/lon pairs. */
  function haversineMiles(lat1, lon1, lat2, lon2) {
    var a1 = num(lat1);
    var o1 = num(lon1);
    var a2 = num(lat2);
    var o2 = num(lon2);
    if (a1 === null || o1 === null || a2 === null || o2 === null) {
      return null;
    }
    var toRad = Math.PI / 180;
    var dLat = (a2 - a1) * toRad;
    var dLon = (o2 - o1) * toRad;
    var s1 = Math.sin(dLat / 2);
    var s2 = Math.sin(dLon / 2);
    var h =
      s1 * s1 +
      Math.cos(a1 * toRad) * Math.cos(a2 * toRad) * s2 * s2;
    return 2 * 3958.7613 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /**
   * Link path length in the calculator's display units (mi or km).
   * Prefer poller distance fields; fall back to haversine from endpoint coords.
   * Used as the share-URL `rd` readout marker (vertical cursor on the SNR graph).
   */
  function linkDistance(linkInfo, fromDevice, toDevice) {
    var wantKm = useKilometers();
    var mi = num(linkInfo && linkInfo.distanceMiles);
    var km = num(linkInfo && linkInfo.distanceKM);
    if (mi === null && km !== null) {
      mi = km * MI_PER_KM;
    }
    if (km === null && mi !== null) {
      km = mi * KM_PER_MI;
    }
    if (mi === null) {
      var lat1 = fromDevice && fromDevice.lat;
      var lon1 = fromDevice && fromDevice.lon;
      var lat2 =
        (toDevice && toDevice.lat) != null
          ? toDevice.lat
          : linkInfo && linkInfo.linkLat;
      var lon2 =
        (toDevice && toDevice.lon) != null
          ? toDevice.lon
          : linkInfo && linkInfo.linkLon;
      mi = haversineMiles(lat1, lon1, lat2, lon2);
      if (mi !== null) {
        km = mi * KM_PER_MI;
      }
    }
    if (wantKm) {
      return km;
    }
    return mi;
  }

  function findReverseLink(peerDevice, sourceName) {
    if (!peerDevice || !peerDevice.link_info || !sourceName) {
      return null;
    }
    var want = nodeKey(sourceName);
    var entries = Object.keys(peerDevice.link_info);
    for (var i = 0; i < entries.length; i++) {
      var li = peerDevice.link_info[entries[i]];
      if (!li || li.linkType !== 'RF') {
        continue;
      }
      if (nodeKey(li.hostname) === want) {
        return li;
      }
    }
    return null;
  }

  function measuredSnr(linkInfo) {
    if (!linkInfo) {
      return null;
    }
    var sig = num(linkInfo.signal);
    var noise = num(linkInfo.noise);
    if (sig === null || noise === null) {
      return null;
    }
    return Math.round((sig - noise) * 10) / 10;
  }

  function deviceCommentBlock(label, device, nameFallback) {
    var lines = [];
    var name = (device && device.node) || nameFallback || label;
    lines.push(label + ': ' + name);
    if (!device) {
      lines.push('  (peer not in map data)');
      return lines.join('\n');
    }
    if (device.model) {
      lines.push('  model: ' + device.model);
    }
    if (device.lat != null && device.lon != null) {
      lines.push('  lat/lon: ' + device.lat + ', ' + device.lon);
    }
    var rf = [];
    if (device.channel != null && device.channel !== '') {
      rf.push('ch ' + device.channel);
    }
    if (device.chanbw != null && device.chanbw !== '') {
      rf.push('bw ' + device.chanbw);
    }
    if (device.freq != null && device.freq !== '') {
      rf.push('freq ' + device.freq + ' MHz');
    }
    if (device.ssid) {
      rf.push('ssid ' + device.ssid);
    }
    if (rf.length) {
      lines.push('  RF: ' + rf.join(', '));
    }
    var ant = [];
    if (device.antDesc && device.antDesc !== 'Not Available') {
      ant.push(device.antDesc);
    }
    if (num(device.antGain) !== null) {
      ant.push('gain ' + device.antGain + ' dBi');
    }
    if (num(device.antBeam) !== null) {
      ant.push('beam ' + device.antBeam + '°');
    }
    if (num(device.antAzimuth) !== null) {
      ant.push('az ' + device.antAzimuth + '°');
    }
    if (num(device.antElevation) !== null) {
      ant.push('el ' + device.antElevation + '°');
    }
    if (num(device.antHeight) !== null) {
      ant.push('height ' + device.antHeight + ' m AGL');
    }
    if (ant.length) {
      lines.push('  antenna: ' + ant.join(', '));
    }
    return lines.join('\n');
  }

  function buildComments(fromDevice, toDevice, linkInfo, fromName, toName) {
    var parts = [];
    parts.push(deviceCommentBlock('Radio A', fromDevice, fromName));
    parts.push(deviceCommentBlock('Radio B', toDevice, toName));
    var linkLines = ['Link:'];
    linkLines.push('  ' + (fromName || 'A') + ' → ' + (toName || 'B'));
    var dMi = num(linkInfo && linkInfo.distanceMiles);
    var dKm = num(linkInfo && linkInfo.distanceKM);
    if (dMi !== null || dKm !== null) {
      linkLines.push(
        '  distance: ' +
          (dMi !== null ? dMi + ' mi' : '') +
          (dMi !== null && dKm !== null ? ' / ' : '') +
          (dKm !== null ? dKm + ' km' : '')
      );
    }
    if (num(linkInfo && linkInfo.bearing) !== null) {
      linkLines.push('  bearing: ' + linkInfo.bearing + '°');
    }
    if (num(linkInfo && linkInfo.signal) !== null) {
      linkLines.push('  signal: ' + linkInfo.signal + ' dBm');
    }
    if (num(linkInfo && linkInfo.noise) !== null) {
      linkLines.push('  noise: ' + linkInfo.noise + ' dBm');
    }
    var snr = measuredSnr(linkInfo);
    if (snr !== null) {
      linkLines.push('  measured SNR: ' + snr + ' dB');
    }
    var rdComment = linkDistance(linkInfo, fromDevice, toDevice);
    if (rdComment !== null && rdComment >= 0) {
      linkLines.push(
        '  calculator readout (rd): ' +
          Math.round(rdComment * 100) / 100 +
          (useKilometers() ? ' km' : ' mi')
      );
    }
    linkLines.push('  note: TX power not available from mesh data (calculator defaults used)');
    parts.push(linkLines.join('\n'));
    return sanitizeComments(parts.join('\n'));
  }

  function pickFreqBw(fromDevice, toDevice) {
    var freq = (fromDevice && num(fromDevice.freq)) || (toDevice && num(toDevice.freq));
    var bw = (fromDevice && parseBw(fromDevice.chanbw)) || (toDevice && parseBw(toDevice.chanbw));
    var preset = frequencyPreset(freq != null ? freq : 5800);
    return {
      f: preset.f,
      fp: preset.fp,
      bw: bw != null ? bw : 10
    };
  }

  function buildUrl(fromDevice, toDevice, linkInfo, fromName, toName) {
    var base = configuredBaseUrl();
    if (!base) {
      return '';
    }
    fromName = fromName || (fromDevice && fromDevice.node) || 'Radio A';
    toName = toName || (toDevice && toDevice.node) || (linkInfo && linkInfo.hostname) || 'Radio B';
    var freqBw = pickFreqBw(fromDevice, toDevice);
    var units = useKilometers() ? 'km' : 'mi';
    // rd = actual RF link length so the calculator readout marker lands on this hop
    var rd = linkDistance(linkInfo, fromDevice, toDevice);
    if (rd === null || rd < 0) {
      rd = 10;
    }
    var floorMax = units === 'km' ? 80 : 50;
    var maxD = Math.max(floorMax, Math.ceil(rd * 2));
    if (rd > 0 && maxD < rd * 1.1) {
      maxD = Math.ceil(rd * 1.25);
    }
    var aGain = fromDevice ? num(fromDevice.antGain) : null;
    var bGain = toDevice ? num(toDevice.antGain) : null;
    var aNf = num(linkInfo && linkInfo.noise);
    var reverse = findReverseLink(toDevice, fromName);
    var bNf = num(reverse && reverse.noise);

    var p = new URLSearchParams();
    p.set('f', String(Math.round(freqBw.f * 10000) / 10000));
    p.set('fp', freqBw.fp);
    p.set('u', units);
    p.set('bw', String(Math.round(freqBw.bw * 100) / 100));
    p.set('max', String(maxD));
    p.set('rd', String(Math.round(rd * 10000) / 10000));
    var comments = buildComments(fromDevice, toDevice, linkInfo, fromName, toName);
    if (comments) {
      p.set('c', comments);
    }
    p.set('a_name', sanitizeName(fromName, 'Radio A'));
    p.set('a_type', antennaTypeFromDesc(fromDevice && fromDevice.antDesc));
    if (aGain !== null) {
      p.set('a_g', String(Math.round(aGain * 100) / 100));
    }
    if (aNf !== null) {
      p.set('a_nf', String(Math.round(aNf * 100) / 100));
    }
    p.set('b_name', sanitizeName(toName, 'Radio B'));
    p.set('b_type', antennaTypeFromDesc(toDevice && toDevice.antDesc));
    if (bGain !== null) {
      p.set('b_g', String(Math.round(bGain * 100) / 100));
    }
    if (bNf !== null) {
      p.set('b_nf', String(Math.round(bNf * 100) / 100));
    }
    return base + '#' + p.toString();
  }

  function linkHtml(fromDevice, toDevice, linkInfo, fromName, toName) {
    var url = buildUrl(fromDevice, toDevice, linkInfo, fromName, toName);
    if (!url) {
      return '';
    }
    return " | <a href='" + escapeAttr(url) + "' target='_blank' rel='noopener'>SNR Calculator</a>";
  }

  function linkHtmlForSourceAndPeer(sourceDeviceOrName, peerHostname, linkInfo) {
    var fromDevice = sourceDeviceOrName;
    var fromName;
    if (typeof sourceDeviceOrName === 'string' || !sourceDeviceOrName) {
      fromName = sourceDeviceOrName || '';
      fromDevice = findDevice(fromName);
    } else {
      fromName = sourceDeviceOrName.node || '';
    }
    var toName = peerHostname || (linkInfo && linkInfo.hostname) || '';
    var toDevice = findDevice(toName);
    return linkHtml(fromDevice, toDevice, linkInfo, fromName, toName);
  }

  return {
    indexDevices: indexDevices,
    findDevice: findDevice,
    isEnabled: isEnabled,
    buildUrl: buildUrl,
    linkHtml: linkHtml,
    linkHtmlForSourceAndPeer: linkHtmlForSourceAndPeer
  };
})();
