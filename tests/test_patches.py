"""Tests for the HEALPix patch grid and footprint coverage. Offline."""
from server.irsa import decode_footprint
from server.patches import (
    NPIX,
    cell_centre,
    cell_of,
    footprint_contains,
    view_cells,
)
from tests.test_irsa import HEX_WKB

BARNARD = (269.4463, 4.7677)
NEIGHBOURS = {2033999, 2034021, 2034032, 2034033, 2034011, 2034009, 2034008, 2033997}


def test_barnard_cell():
    assert cell_of(*BARNARD) == 2034010
    ra, dec = cell_centre(2034010)
    assert abs(ra - 269.38477) < 1e-4
    assert abs(dec - 4.78019) < 1e-4


def test_view_rings_small():
    cells = view_cells(*BARNARD, 0.15)
    ring0 = {p for p, r in cells.items() if r == 0}
    ring1 = {p for p, r in cells.items() if r == 1}
    ring2 = {p for p, r in cells.items() if r == 2}
    assert 2034010 in ring0
    assert NEIGHBOURS <= ring1 | ring0
    assert NEIGHBOURS - ring0 <= ring1
    assert ring2
    assert len(ring0) + len(ring1) + len(ring2) == len(cells)


def test_view_rings_pole():
    for dec in (89.9, -89.9):
        cells = view_cells(10.0, dec, 0.3)
        assert any(r == 0 for r in cells.values())
        assert any(r == 1 for r in cells.values())
        assert all(0 <= p < NPIX for p in cells)


def test_footprint_contains_known():
    fp = decode_footprint(HEX_WKB)
    assert footprint_contains(fp, 269.4463, 4.7677)
    assert not footprint_contains(fp, 272.0, 4.0)


def test_footprint_wraps_ra0():
    fp = ((359.0, -1.0), (1.0, -1.0), (1.0, 1.0), (359.0, 1.0))
    assert footprint_contains(fp, 0.0, 0.0)
    assert footprint_contains(fp, 359.9, 0.5)
    assert not footprint_contains(fp, 2.0, 0.0)


def test_ring0_is_overlap():
    cells = view_cells(*BARNARD, 0.15)
    ring0 = {p for p, r in cells.items() if r == 0}
    assert len(ring0) >= 2
    assert (ring0 - {2034010}) <= NEIGHBOURS
