"""Group exposures into visits and pick the first batch to show.

A visit is a run of consecutive exposures (sorted by MJD) where neighbours
are at most 60 days apart; a larger gap starts a new visit. A visit that runs
longer than 60 days without a gap is cut into equal slices. The first batch
is one exposure per (visit, detector), the one whose MJD is nearest the
visit's midpoint (mean of the first and last MJD in the visit).

These functions only look at metadata (uri, mjd, detector). No pixels are
touched, so NaN image data never reaches this module.
"""

import math

from server.irsa import Exposure

VISIT_GAP_DAYS = 60.0


def group_visits(exposures: list[Exposure]) -> list[list[Exposure]]:
    """Split exposures into visits; a gap of more than 60 days starts one.

    Input order does not matter: exposures are sorted by MJD first. Ties in
    MJD keep their input order (sort is stable).
    """
    exposures = sorted(exposures, key=lambda e: e.mjd)
    visits: list[list[Exposure]] = []
    for exposure in exposures:
        if visits and exposure.mjd - visits[-1][-1].mjd <= VISIT_GAP_DAYS:
            visits[-1].append(exposure)
        else:
            visits.append([exposure])
    return [part for visit in visits for part in _slices(visit)]


def _slices(visit: list[Exposure]) -> list[list[Exposure]]:
    """Cut a visit longer than 60 days into equal time slices of at most 60 days.

    Near the ecliptic poles the sky is observed almost daily, so no gap ever opens
    and the whole survey would be one visit with a single blink frame per detector.
    """
    span = visit[-1].mjd - visit[0].mjd
    if span <= VISIT_GAP_DAYS:
        return [visit]
    count = math.ceil(span / VISIT_GAP_DAYS)
    width = span / count
    parts: list[list[Exposure]] = [[] for _ in range(count)]
    for exposure in visit:
        index = min(int((exposure.mjd - visit[0].mjd) / width), count - 1)
        parts[index].append(exposure)
    return [part for part in parts if part]


def first_batch(exposures: list[Exposure]) -> set[str]:
    """One uri per (visit, detector): the MJD nearest the visit midpoint.

    The midpoint is the mean of the first and last MJD of the visit. Ties
    (two exposures equally near the midpoint) go to the earlier MJD.
    """
    batch: set[str] = set()
    for visit in group_visits(exposures):
        midpoint = (visit[0].mjd + visit[-1].mjd) / 2
        chosen: dict[int, Exposure] = {}
        for exposure in visit:
            best = chosen.get(exposure.detector)
            if best is None or (abs(exposure.mjd - midpoint), exposure.mjd) < (
                abs(best.mjd - midpoint),
                best.mjd,
            ):
                chosen[exposure.detector] = exposure
        batch.update(exposure.uri for exposure in chosen.values())
    return batch
