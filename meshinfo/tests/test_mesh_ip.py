import logging

from meshinfoPoller import NodePoller, mesh_ip_from_sysinfo

# Trimmed /a/sysinfo from KB7PPM-M5-Rock-FFB3 (AREDN 4.26.10.0)
CURRENT_FIRMWARE = {
    'node': 'KB7PPM-M5-Rock-FFB3',
    'ip': '10.104.255.179',
    'interfaces': [
        {'name': 'eth0', 'mac': '04:18:d6:69:ff:b3'},
        {'name': 'br-mesh', 'mac': '36:df:0f:d5:57:fa', 'ip': '10.104.255.179'},
        {'name': 'br-dtdlink', 'mac': '02:3e:73:8d:75:31', 'ip': '169.254.117.49'},
        {'name': 'br-lan', 'mac': '02:ad:cc:ba:42:1f', 'ip': '10.143.251.49'},
        {'name': 'wlan0', 'mac': '04:18:d6:68:ff:b3', 'ip': '169.254.255.179'},
    ],
}

LEGACY_FIRMWARE = {
    'node': 'OLD-NODE',
    'interfaces': [
        {'name': 'br-lan', 'ip': '10.20.30.1'},
        {'name': 'wlan0', 'mac': 'aa:bb:cc:dd:ee:ff', 'ip': '10.1.2.3'},
    ],
}


def _parse(data, polled_ip):
    poller = NodePoller(session=None, logger=logging.getLogger('test'))
    return poller._parse_sysinfo(data, polled_ip)


def test_current_firmware_uses_br_mesh_not_link_local_wlan():
    assert mesh_ip_from_sysinfo(CURRENT_FIRMWARE) == '10.104.255.179'

    node = _parse(CURRENT_FIRMWARE, '10.104.255.179')
    assert node.wlan_ip == '10.104.255.179'
    assert node.lan_ip == '10.143.251.49'
    assert node.wifi_mac_address == '04:18:d6:68:ff:b3'


def test_br_mesh_wins_over_top_level_ip():
    data = dict(CURRENT_FIRMWARE, ip='10.9.9.9')
    assert mesh_ip_from_sysinfo(data) == '10.104.255.179'


def test_top_level_ip_when_no_br_mesh():
    data = {'ip': '10.5.5.5', 'interfaces': [{'name': 'wlan0', 'ip': '169.254.1.1'}]}
    assert mesh_ip_from_sysinfo(data) == '10.5.5.5'


def test_legacy_firmware_uses_wlan_mesh_ip_not_lan():
    assert mesh_ip_from_sysinfo(LEGACY_FIRMWARE) == '10.1.2.3'


def test_falls_back_to_polled_ip_when_only_link_local():
    data = {'interfaces': [{'name': 'wlan0', 'ip': '169.254.1.1'}]}
    assert mesh_ip_from_sysinfo(data) is None
    assert _parse(data, '10.7.7.7').wlan_ip == '10.7.7.7'
