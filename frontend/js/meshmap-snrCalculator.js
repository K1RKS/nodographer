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

  function linkDistance(linkInfo) {
    if (!linkInfo) {
      return null;
    }
    if (useKilometers()) {
      return num(linkInfo.distanceKM);
    }
    return num(linkInfo.distanceMiles);
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
    var rd = linkDistance(linkInfo);
    if (rd === null || rd < 0) {
      rd = 10;
    }
    var maxD = Math.max(units === 'km' ? 80 : 50, Math.ceil(rd * 2));
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
