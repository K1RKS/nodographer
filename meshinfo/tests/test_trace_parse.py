from trace_parse import parse_stableroute_text, parse_traceroute_text


SAMPLE_TR = """
traceroute to nodec.local.mesh (10.1.2.5), 30 hops max, 46 byte packets
Aredn-Traceroute(0.1.26-r0): Babel Metric 4078
 1 nodea (10.1.2.3) 23 ms DtD 96/96 (100%/100%) 352 0%
 2 nodeb (10.1.2.4) 123 ms RF 3593/3520 (98%/99%) 3945 1%
 3 nodec (10.1.2.5) 19 ms WG 133/133 (100%/100%) 4078 0%
"""

SAMPLE_SR = """
stableroute(0.1.36-r0): destination nodec  runs 10
using aredn-traceroute
Summary:
  unique paths: 2
  shortest route: 3 hops
  longest route: 3 hops
  Unreachable: 0
  most common: 7/10 (70%)

-------------------------------------------------
Path 1: 7/10 (70%)
  1 nodea (10.1.2.3) DtD  avg 12ms +- 3ms
  2 nodeb (10.1.2.4) RF  avg 45ms +- 8ms
  3 nodec (10.1.2.5) DtD  avg 50ms +- 5ms

-------------------------------------------------
Path 2: 3/10 (30%)
  1 noded (10.2.0.1) WG  avg 20ms +- 1ms
  2 nodee (10.2.0.2) WG  avg 33ms +- 4ms
  3 nodec (10.1.2.5) DtD  avg 55ms +- 6ms
"""


def test_parse_traceroute_text():
    doc = parse_traceroute_text(SAMPLE_TR)
    assert doc['schemaVersion'] == 1
    assert doc['tool'] == 'aredn-traceroute'
    assert doc['destination'] == 'nodec'
    assert len(doc['paths']) == 1
    hops = doc['paths'][0]['hops']
    assert [h['hostname'] for h in hops] == ['nodea', 'nodeb', 'nodec']
    assert hops[1]['linkType'] == 'RF'
    assert hops[0]['rttMs'] == 23


def test_parse_stableroute_text():
    doc = parse_stableroute_text(SAMPLE_SR)
    assert doc['tool'] == 'stableroute'
    assert doc['runs'] == 10
    assert doc['summary']['uniquePaths'] == 2
    assert len(doc['paths']) == 2
    assert doc['paths'][0]['count'] == 7
    assert doc['paths'][0]['hops'][1]['rttAvgMs'] == 45
    assert doc['paths'][0]['key'] == 'nodea|nodeb|nodec'
