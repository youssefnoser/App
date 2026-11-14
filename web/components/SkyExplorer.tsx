'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { targets as initialTargets } from '@/lib/sky';
import { cachedFetch } from '@/js/frontend-cache.js';
import type { BackendTimeline, LoadProgress } from '@/js/backend-sky.js';
import BandSelector from './BandSelector';
import { getBandWavelength } from '@/lib/spectral';
import { describeProgress } from '@/lib/load-progress';
import Rotor from './Rotor';
import ZoomRuler from './ZoomRuler';
import SkyCanvas, { type SkyGoto, type SkyView } from './SkyCanvas';
import ImageMath from './ImageMath';
import { GoogleMyLocationIcon, GoogleLayersIcon } from './GoogleMapIcons';

function SpaceTargetIcon({ type }: { type: string }) {
  if (type.includes('BROWN DWARF')) {
    // Ringed substellar world / brown dwarf with planetary rings
    return (
      <span className="target-icon-badge brown-dwarf-badge" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="5" fill="rgba(192, 132, 252, 0.25)" stroke="#c084fc" />
          <ellipse cx="12" cy="12" rx="9.5" ry="3.5" transform="rotate(-25 12 12)" stroke="#e9d5ff" strokeWidth="1.3" />
        </svg>
      </span>
    );
  }
  if (type.includes('PROPER-MOTION')) {
    // High-proper motion star with motion streak vector & astrometric spikes
    return (
      <span className="target-icon-badge motion-star-badge" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="13" cy="11" r="3.5" fill="rgba(56, 189, 248, 0.3)" stroke="#38bdf8" />
          <line x1="13" y1="3" x2="13" y2="6" stroke="#38bdf8" strokeWidth="1.5" />
          <line x1="13" y1="16" x2="13" y2="19" stroke="#38bdf8" strokeWidth="1.5" />
          <line x1="5" y1="11" x2="8" y2="11" stroke="#38bdf8" strokeWidth="1.5" />
          <line x1="18" y1="11" x2="21" y2="11" stroke="#38bdf8" strokeWidth="1.5" />
          <path d="M4 19c2.5-1 5.5-3.5 7.5-6.5" stroke="#7dd3fc" strokeWidth="1.4" strokeDasharray="2 2" />
        </svg>
      </span>
    );
  }
  // Variable star with circumstellar accretion disk
  return (
    <span className="target-icon-badge variable-star-badge" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="4.2" fill="rgba(251, 191, 36, 0.25)" stroke="#fbbf24" />
        <ellipse cx="12" cy="12" rx="9" ry="3.2" transform="rotate(-20 12 12)" stroke="#fef08a" strokeWidth="1.3" strokeDasharray="3 2" />
        <circle cx="12" cy="12" r="1.5" fill="#ffffff" />
      </svg>
    </span>
  );
}

export type SearchHistoryItem = {
  id: string;
  query: string;
  name?: string;
  type?: string;
  ra: number;
  dec: number;
  timestamp: number;
};

export default function SkyExplorer() {
  const [targets, setTargets] = useState(initialTargets);
  const [sequence, setSequence] = useState<BackendTimeline>({steps:[],index:0});
  const savedStep = useRef<number | null>(null);
  const sequenceRef = useRef(sequence);
  sequenceRef.current = sequence;
  const frameCount = sequence.steps.length;
  const lastFrame = Math.max(0, frameCount - 1);
  const onTimeline = useCallback((next: BackendTimeline) => {
    setSequence(next);
    if (savedStep.current !== null && next.steps.length > savedStep.current) {
      setFrame(savedStep.current);
      savedStep.current = null;
    } else setFrame(next.index);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const hasInitialPosition = new URLSearchParams(location.search).has('ra') || location.hash.includes('ra=');
    cachedFetch('/api/targets', {signal:controller.signal}).then(async response => {
      if (!response.ok) throw Error('Targets unavailable');
      const live = await response.json();
      if (!Array.isArray(live)) throw Error('Invalid target list');
      const normalize = (name: string) => name.toLowerCase().replaceAll(String.fromCharCode(8217), '').replaceAll("'", '');
      const updated = initialTargets.map(target => {
        const match = live.find(item => typeof item.name === 'string' && normalize(item.name) === normalize(target.name));
        return match && Number.isFinite(match.ra) && match.ra >= 0 && match.ra < 360 && Number.isFinite(match.dec) && Math.abs(match.dec) <= 90 ? {...target,ra:match.ra,dec:match.dec} : target;
      });
      if (controller.signal.aborted) return;
      setTargets(updated);
      if (!hasInitialPosition && !new URLSearchParams(location.search).has('ra')) {
        setCoordinates({ra:updated[0].ra,dec:updated[0].dec});
        flyTo({ra:updated[0].ra,dec:updated[0].dec,fovDeg:5/60});
      }
    }).catch(() => {});
    return () => controller.abort();
  }, []);
  const [searchOpen, setSearchOpen] = useState(false), [query, setQuery] = useState(''), [message, setMessage] = useState('');
  const [history, setHistory] = useState<SearchHistoryItem[]>([]);
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('sky-search-history') ?? '[]');
      if (Array.isArray(stored)) {
        const parsed: SearchHistoryItem[] = stored
          .map((item: any) => {
            if (!item || !Number.isFinite(item.ra) || !Number.isFinite(item.dec)) return null;
            const matching = targets.find(
              (t) => Math.abs(t.ra - item.ra) < 0.001 && Math.abs(t.dec - item.dec) < 0.001
            );
            return {
              id: item.id || `${item.ra.toFixed(4)}:${item.dec.toFixed(4)}`,
              query: item.query || (matching ? matching.name : `${item.ra.toFixed(4)}°, ${item.dec.toFixed(4)}°`),
              name: item.name || matching?.name,
              type: item.type || (matching ? matching.type : 'COORDINATES'),
              ra: item.ra,
              dec: item.dec,
              timestamp: item.timestamp || Date.now(),
            };
          })
          .filter(Boolean) as SearchHistoryItem[];
        setHistory(parsed.slice(0, 8));
      }
    } catch {}
  }, []);
  const [selected, setSelected] = useState(0);
  const [coordinates, setCoordinates] = useState({ ra: 269.4521, dec: 4.6934 });
  const [viewCoordinates, setViewCoordinates] = useState({ ra: 269.4521, dec: 4.6934 });
  // The engine owns the view (as on index.html). `zoom` mirrors its field of view
  // (1 = 5 arcmin) for the labels; `goto` sends it an explicit move.
  const [zoom, setZoom] = useState(1);
  const [goto, setGoto] = useState<SkyGoto>({ id: 0, ra: 269.4521, dec: 4.6934, fovDeg: 5 / 60 });
  const flyTo = useCallback((move: Omit<SkyGoto, 'id'>) => setGoto(current => ({ ...move, id: current.id + 1 })), []);
  const onView = useCallback((view: SkyView) => {
    setViewCoordinates({ ra: view.ra, dec: view.dec });
    setZoom((5 / 60) / view.fovDeg);
  }, []);
  const [frame, setFrame] = useState(0), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(1), [loop, setLoop] = useState(true);
  const [infrared, setInfrared] = useState(true), [grid, setGrid] = useState(true), [bands, setBands] = useState<number[]>([22]);
  const [sequenceWavelength, setSequenceWavelength] = useState<number | undefined>(1.25);
  const [sequenceWidth, setSequenceWidth] = useState(.05);
  const [gaiaEnabled, setGaiaEnabled] = useState(false);
  const [wiseEnabled, setWiseEnabled] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [bandsOpen, setBandsOpen] = useState(false);
  const searchDock = useRef<HTMLDivElement>(null), searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!searchDock.current?.contains(event.target as Node)) setSearchOpen(false); };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, []);
  useEffect(() => {
    const fromHash = location.hash.includes('ra=');
    const params = new URLSearchParams(fromHash ? location.hash.slice(1) : location.search), a = params.get('ra'), d = params.get('dec');
    const fov = Number(params.get('fov')), epoch = Number(params.get(fromHash ? 'step' : 'frame'));
    // The hash holds the fov in degrees, the query string in arcmin.
    const fovDeg = params.has('fov') && Number.isFinite(fov) && fov > 0 ? (fromHash ? fov : fov / 60) : undefined;
    if (params.has(fromHash ? 'step' : 'frame') && Number.isInteger(epoch) && epoch >= 0) { savedStep.current = epoch; setFrame(epoch); }
    if (a !== null && d !== null && a.trim() && d.trim() && Number.isFinite(+a) && Number.isFinite(+d) && +a >= 0 && +a < 360 && +d >= -90 && +d <= 90) {
      setCoordinates({ ra: +a, dec: +d });
      flyTo({ ra: +a, dec: +d, fovDeg });
      setSelected(targets.findIndex(target => Math.abs(target.ra - +a) < .001 && Math.abs(target.dec - +d) < .001));
    }
  }, []);
  useEffect(() => {
    if (!playing || frameCount < 2) return;
    const timer = setInterval(() => setFrame(current => {
      const count = sequenceRef.current.steps.length;
      if (!count || (current === count - 1 && !loop)) return current;
      return (current + 1) % count;
    }), 600 / speed);
    return () => clearInterval(timer);
  }, [playing, loop, speed, frameCount]);
  useEffect(() => { if (playing && frame === lastFrame && !loop) setPlaying(false); }, [frame, loop, playing, lastFrame]);
  const playState = useRef({ playing, frame, lastFrame, frameCount });
  playState.current = { playing, frame, lastFrame, frameCount };
  // Play from the start when stopped on the last step; a single step has nothing to blink.
  const togglePlay = useCallback(() => {
    const { playing, frame, lastFrame, frameCount } = playState.current;
    if (!playing && frame === lastFrame) setFrame(0);
    if (frameCount >= 2) setPlaying(!playing);
  }, []);
  // Space plays and pauses anywhere on the page except while typing. Handled on
  // keydown and kept from the focused button too, which would otherwise click on keyup.
  useEffect(() => {
    const isSpace = (event: KeyboardEvent) => event.code === 'Space' || event.key === ' ';
    const typing = (target: EventTarget | null) => target instanceof HTMLElement
      && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    const down = (event: KeyboardEvent) => {
      if (!isSpace(event) || event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return;
      event.preventDefault();
      if (!event.repeat) togglePlay();
    };
    const up = (event: KeyboardEvent) => { if (isSpace(event) && !typing(event.target)) event.preventDefault(); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [togglePlay]);
  const onField = useCallback((arcmin: number) => flyTo({ fovDeg: arcmin / 60 }), [flyTo]);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const status = describeProgress(progress);
  const onBands = useCallback((next: number[]) => { setBands(next); setSequenceWavelength(undefined); }, []);
  const onWavelength = useCallback((value: number) => {
    const nearest = Array.from({length:102}, (_, i) => i + 1).reduce((a, b) =>
      Math.abs(getBandWavelength(a) - value) < Math.abs(getBandWavelength(b) - value) ? a : b);
    setBands([nearest]);setSequenceWavelength(value);
  }, []);
  function saveHistoryItem(item: { query: string; name?: string; type?: string; ra: number; dec: number }) {
    setHistory((prev) => {
      const filtered = prev.filter(
        (h) => Math.hypot(h.ra - item.ra, h.dec - item.dec) > 0.0005 && h.query.toLowerCase() !== item.query.toLowerCase()
      );
      const next: SearchHistoryItem[] = [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          query: item.query,
          name: item.name,
          type: item.type || 'COORDINATES',
          ra: item.ra,
          dec: item.dec,
          timestamp: Date.now(),
        },
        ...filtered,
      ].slice(0, 8);
      try {
        localStorage.setItem('sky-search-history', JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  function removeHistoryItem(id: string) {
    setHistory((prev) => {
      const next = prev.filter((h) => h.id !== id);
      try {
        localStorage.setItem('sky-search-history', JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  function clearHistory() {
    setHistory([]);
    try {
      localStorage.removeItem('sky-search-history');
    } catch {}
  }

  function updateCoordinates(a: number, d: number) {
    setCoordinates({ ra: a, dec: d });
    const url = new URL(location.href);
    url.searchParams.set('ra', String(a));
    url.searchParams.set('dec', String(d));
    url.hash = '';
    savedStep.current = null;
    window.history.replaceState(null, '', url);
    flyTo({ ra: a, dec: d, fovDeg: 5 / 60 });
    setFrame(0);
    setPlaying(false);
  }

  function chooseTarget(index: number) {
    const target = targets[index];
    setSelected(index);
    updateCoordinates(target.ra, target.dec);
    saveHistoryItem({
      query: target.name,
      name: target.name,
      type: target.type,
      ra: target.ra,
      dec: target.dec,
    });
    setQuery('');
    setMessage(`Exploring ${target.name}`);
    setSearchOpen(false);
  }

  function search(event: FormEvent) {
    event.preventDefault();
    const normalize = (value: string) => value.toLowerCase().replace(/[’']/g, '').trim();
    const text = query.trim();
    if (!text) {
      setMessage('Enter an object name or RA, Dec in degrees.');
      return;
    }
    const pair = text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*\u00b0?\s*(?:,\s*|\s+)([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*\u00b0?$/);
    if (pair) {
      const a = Number(pair[1]), d = Number(pair[2]);
      if (a < 0 || a >= 360 || d < -90 || d > 90) {
        setMessage('RA must be 0 to less than 360 degrees; Dec must be -90 to 90 degrees.');
        return;
      }
      updateCoordinates(a, d);
      const matchIdx = targets.findIndex(item => Math.abs(item.ra - a) < .001 && Math.abs(item.dec - d) < .001);
      setSelected(matchIdx);
      saveHistoryItem({
        query: `${a.toFixed(4)}°, ${d.toFixed(4)}°`,
        name: matchIdx >= 0 ? targets[matchIdx].name : undefined,
        type: matchIdx >= 0 ? targets[matchIdx].type : 'COORDINATES',
        ra: a,
        dec: d,
      });
      setMessage(`Exploring ${a} degrees, ${d} degrees`);
      setQuery('');
      setSearchOpen(false);
      return;
    }
    const index = targets.findIndex(target => normalize(target.name).includes(normalize(query)));
    if (index >= 0) {
      chooseTarget(index);
    } else {
      setMessage('Try Barnard’s Star, Epsilon Indi B, WISE 0855, RW Aurigae, or R Draconis.');
    }
  }
  const target = targets[selected];
  const readout = viewCoordinates;
  return <main>
    <div
      className={`search-dock${searchOpen || query ? ' is-searching' : ''}${advancedOpen ? ' dock-hidden' : ''}`}
      ref={searchDock}
      style={advancedOpen ? { opacity: 0, pointerEvents: 'none', visibility: 'hidden' } : undefined}
      onKeyDown={event => { if (event.key === 'Escape') { setSearchOpen(false); searchInput.current?.focus(); } }}
    >
      <form onSubmit={search}>
        <span className="search-glass-icon" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </span>
        <input ref={searchInput} aria-label="Search celestial objects" aria-expanded={searchOpen} aria-controls="sky-search-options" placeholder="Search the sky…" value={query} onFocus={() => setSearchOpen(true)} onClick={() => setSearchOpen(true)} onChange={event => { setQuery(event.target.value); setSearchOpen(true); }} />
        {query && (
          <button type="button" className="search-clear-btn" aria-label="Clear search input" onClick={() => { setQuery(''); searchInput.current?.focus(); }}>
            ✕
          </button>
        )}
      </form>
      <div id="sky-search-options" className="search-options" hidden={!searchOpen}>
        {history.length > 0 && (
          <div className="search-history-container">
            <div className="search-history-header">
              <span className="eyebrow">RECENT SEARCHES</span>
              <button
                type="button"
                className="clear-history-button"
                onClick={clearHistory}
                aria-label="Clear all search history"
              >
                Clear all
              </button>
            </div>
            <div className="search-history-list">
              {history.map((item) => (
                <div key={item.id} className="search-history-row">
                  <button
                    type="button"
                    className="history-entry-button"
                    onClick={() => {
                      updateCoordinates(item.ra, item.dec);
                      const idx = targets.findIndex(
                        (t) => Math.abs(t.ra - item.ra) < 0.001 && Math.abs(t.dec - item.dec) < 0.001
                      );
                      setSelected(idx);
                      saveHistoryItem(item);
                      setQuery('');
                      setSearchOpen(false);
                      setMessage(`Exploring ${item.name ?? `${item.ra.toFixed(4)}°, ${item.dec.toFixed(4)}°`}`);
                    }}
                  >
                    <span className="history-space-icon" aria-hidden="true">
                      {item.type && item.type !== 'COORDINATES' ? (
                        <SpaceTargetIcon type={item.type} />
                      ) : (
                        <span className="target-icon-badge coord-badge">
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#7dd3fc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="9" />
                            <circle cx="12" cy="12" r="3" />
                            <line x1="12" y1="3" x2="12" y2="7" />
                            <line x1="12" y1="17" x2="12" y2="21" />
                            <line x1="3" y1="12" x2="7" y2="12" />
                            <line x1="17" y1="12" x2="21" y2="12" />
                          </svg>
                        </span>
                      )}
                    </span>
                    <span className="history-text">
                      <strong>{item.name ?? item.query}</strong>
                      <small>
                        {item.ra.toFixed(4)}°, {item.dec >= 0 ? '+' : ''}{item.dec.toFixed(4)}°
                        {item.name && item.name !== item.query ? ` · "${item.query}"` : ''}
                      </small>
                    </span>
                    <span className="history-jump">↗</span>
                  </button>
                  <button
                    type="button"
                    className="history-delete-btn"
                    aria-label={`Delete ${item.name ?? item.query} from history`}
                    title="Delete item"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeHistoryItem(item.id);
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="search-options-heading"><span className="eyebrow">EXPLORE THE SKY</span></div>
        <div className="search-targets">
          {targets
            .filter(item => !query.trim() || item.name.toLowerCase().replace(/[’']/g, '').includes(query.toLowerCase().replace(/[’']/g, '').trim()))
            .map(item => (
              <button key={item.name} type="button" onClick={() => chooseTarget(targets.indexOf(item))}>
                <SpaceTargetIcon type={item.type} />
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.description}</small>
                </span>
                <span>↗</span>
              </button>
            ))}
        </div>
        <p id="search-coordinate-hint" className="search-coordinate-hint">Search a name or enter coordinates in degrees, e.g. 269.4521, +4.6934</p>
      </div>
    </div>
    <section className="sky" aria-label="Interactive sky map">
      <SkyCanvas
        goto={goto}
        target={coordinates}
        frame={frame}
        bands={bands}
        sequenceWavelength={sequenceWavelength}
        sequenceWidth={sequenceWidth}
        onTimeline={onTimeline}
        onStatus={setMessage}
        onProgress={setProgress}
        onView={onView}
        infrared={infrared}
        grid={grid}
        name={target?.name ?? `${coordinates.ra.toFixed(4)}°, ${coordinates.dec >= 0 ? '+' : ''}${coordinates.dec.toFixed(4)}°`}
        objectType={target?.type ?? 'CUSTOM COORDINATES'}
        gaiaEnabled={gaiaEnabled}
        wiseEnabled={wiseEnabled}
      />
      <div className="map-top">
        <div className="map-top-left">
          <ImageMath
            frame={frame}
            bands={bands}
            coordinates={coordinates}
            targetName={target?.name ?? 'Your sky region'}
            gaiaEnabled={gaiaEnabled}
            wiseEnabled={wiseEnabled}
            onToggleGaia={() => setGaiaEnabled(!gaiaEnabled)}
            onToggleWise={() => setWiseEnabled(!wiseEnabled)}
            onSelectBand={(b) => onBands([b])}
            onSelectBands={onBands}
            onSelectCoords={(ra, dec) => updateCoordinates(ra, dec)}
            onOpenChange={setAdvancedOpen}
          />
          {!advancedOpen && (
            <div className="map-coordinate">ICRS <span>{readout.ra.toFixed(4)}°, {readout.dec >= 0 ? '+' : ''}{readout.dec.toFixed(4)}°</span></div>
          )}
        </div>
        <div className="view-switch"><button className={infrared ? 'selected' : ''} onClick={() => setInfrared(true)}>Infrared</button><button className={!infrared ? 'selected' : ''} onClick={() => setInfrared(false)}>Visible</button></div>
      </div>
      <div className="map-tools">
        <button
          aria-label="Recenter map"
          title="Recenter on target"
          onClick={() => flyTo({ ra: coordinates.ra, dec: coordinates.dec, fovDeg: 5 / 60, retry: true })}
        >
          <GoogleMyLocationIcon />
        </button>
        <button aria-label="Toggle coordinate grid" aria-pressed={grid} title="Equatorial Grid" onClick={() => setGrid(!grid)}>
          <GoogleLayersIcon />
        </button>
        <button
          aria-label="Toggle Gaia DR3 overlay"
          aria-pressed={gaiaEnabled}
          className={`overlay-toggle-btn ${gaiaEnabled ? 'active' : ''}`}
          title="Gaia DR3 Overlay"
          onClick={() => setGaiaEnabled(!gaiaEnabled)}
        >
          G
        </button>
        <button
          aria-label="Toggle WISE overlay"
          aria-pressed={wiseEnabled}
          className={`overlay-toggle-btn ${wiseEnabled ? 'active' : ''}`}
          title="AllWISE Mid-IR Overlay"
          onClick={() => setWiseEnabled(!wiseEnabled)}
        >
          W
        </button>
      </div>
      <BandSelector selected={bands} onSelection={onBands} onOpenChange={setBandsOpen} wavelength={sequenceWavelength ?? getBandWavelength(bands[0] ?? 22)} width={sequenceWidth} onWavelength={onWavelength} onWidth={setSequenceWidth} />
      <ZoomRuler field={5 / zoom} status={status} frames={frameCount} onChange={onField} />
      <section className="timeline rotary-console" aria-label="Sky controls">
        <><div className="knob-section time-section half-section"><Rotor id="time-knob" label="Observation frame" value={frame} min={0} max={Math.max(1, lastFrame)} step={1} labels={Array.from({length:6}, (_, i) => sequence.steps[Math.round(i * lastFrame / 5)]?.date.slice(5).replace('-', '/') ?? '--')} onChange={setFrame} onGrab={() => setPlaying(false)} progress={progress?.total ? status : undefined}><span>{sequence.steps[frame]?.date ?? (status.tone === 'idle' ? '—' : status.title)}</span><small>FRAME {String(frameCount ? frame + 1 : 0).padStart(2, '0')} / {String(frameCount).padStart(2, '0')}</small>{frameCount > 0 && <small className="load-status" data-tone={status.tone} title={status.detail}>{status.title}</small>}</Rotor></div>
        <div className="knob-section speed-section half-section"><Rotor id="speed-knob" label="Playback speed" value={speed} min={.5} max={3} step={.5} labels={['0.5×', '1×', '1.5×', '2×', '2.5×', '3×']} onChange={setSpeed}><span>{speed}×</span><small>PLAYBACK SPEED</small></Rotor></div>
        <div className="playback-panel"><div className="playback-buttons"><button aria-label="Previous frame" onClick={() => { setPlaying(false); setFrame(Math.max(0, frame - 1)); }}>◀</button><button className="play" aria-label={playing ? 'Pause observations' : 'Play observations'} aria-keyshortcuts="Space" title={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={togglePlay}>{playing ? 'Ⅱ' : '▶'}</button><button aria-label="Next frame" onClick={() => { setPlaying(false); setFrame(Math.min(lastFrame, frame + 1)); }}>▶</button><button className={`loop${loop ? ' active' : ''}`} aria-label="Loop playback" aria-pressed={loop} onClick={() => setLoop(!loop)}>↻</button></div></div>
        </>
      </section>
    </section>
    <div className="search-feedback" role="status" hidden={searchOpen}>{message}</div>
  </main>;
}
