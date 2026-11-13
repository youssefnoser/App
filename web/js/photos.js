// Cache of Stellarium photo objects, one per (patch, exposure), capped.

export class PhotoCache {
  /**
   * @param layer Stellarium layer with add(type, args) and remove(photo).
   * @param {{cap?: number}} opts cap is the most photo objects kept (default 600).
   */
  constructor(layer, { cap = 600 } = {}) {
    this.layer = layer;
    this.cap = cap;
    // Map keeps insertion order; every ensure() re-inserts, so the first
    // entry is the least recently ensured.
    this.entries = new Map(); // key -> {photo, uri}
    this.current = null;
  }

  get size() {
    return this.entries.size;
  }

  /**
   * Return the photo for this patch and exposure, adding it (hidden) if new.
   * Marks it most recently used, then drops the least recently ensured photos
   * that are not part of the current uri until the cache is within its cap.
   */
  ensure(pix, uri, url, cal) {
    const key = `${pix}|${uri}`;
    let entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
    } else {
      const photo = this.layer.add('photo', {
        url,
        calibration: cal,
        visible: false,
        instant: true,
      });
      entry = { photo, uri };
    }
    this.entries.set(key, entry);
    this._trim(key);
    return entry.photo;
  }

  /**
   * Show exactly the photos of this uri and hide all others. A patch with no
   * photo for the uri shows nothing.
   */
  showOnly(uri) {
    this.current = uri;
    for (const entry of this.entries.values()) {
      entry.photo.visible = entry.uri === uri;
    }
  }

  _trim(justAdded) {
    if (this.entries.size <= this.cap) return;
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.cap) break;
      if (key === justAdded || entry.uri === this.current) continue;
      this.layer.remove(entry.photo);
      this.entries.delete(key);
    }
  }
}
