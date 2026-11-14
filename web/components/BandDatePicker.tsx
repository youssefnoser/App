'use client';
import { useState } from 'react';
import { getBandWavelength } from '@/lib/spectral';
import { detectorBands } from '@/lib/sky';

type Props = {
  selectedBands: number[];
  onChangeBands: (bands: number[]) => void;
};

const DETECTOR_INFO = [
  { id: 1, name: 'Detector 1', minWl: '0.75', maxWl: '1.11', range: '0.75 – 1.11 µm' },
  { id: 2, name: 'Detector 2', minWl: '1.11', maxWl: '1.64', range: '1.11 – 1.64 µm' },
  { id: 3, name: 'Detector 3', minWl: '1.64', maxWl: '2.42', range: '1.64 – 2.42 µm' },
  { id: 4, name: 'Detector 4', minWl: '2.42', maxWl: '3.82', range: '2.42 – 3.82 µm' },
  { id: 5, name: 'Detector 5', minWl: '3.82', maxWl: '4.42', range: '3.82 – 4.42 µm' },
  { id: 6, name: 'Detector 6', minWl: '4.42', maxWl: '5.00', range: '4.42 – 5.00 µm' },
];

export default function BandDatePicker({ selectedBands, onChangeBands }: Props) {
  const [activeDetector, setActiveDetector] = useState<number>(1);
  const currentInfo = DETECTOR_INFO[activeDetector - 1];
  const currentBands = detectorBands(activeDetector);

  const selectedInCurrent = currentBands.filter((b) => selectedBands.includes(b));
  const allInCurrentSelected = selectedInCurrent.length === 17;

  function toggleBand(band: number) {
    if (selectedBands.includes(band)) {
      if (selectedBands.length === 1) return; // Keep at least one band selected
      onChangeBands(selectedBands.filter((b) => b !== band));
    } else {
      onChangeBands([...selectedBands, band].sort((a, b) => a - b));
    }
  }

  function toggleCurrentDetector() {
    if (allInCurrentSelected) {
      const remaining = selectedBands.filter((b) => !currentBands.includes(b));
      onChangeBands(remaining.length > 0 ? remaining : [currentBands[0]]);
    } else {
      const updated = Array.from(new Set([...selectedBands, ...currentBands])).sort((a, b) => a - b);
      onChangeBands(updated);
    }
  }

  function selectAllSurveyBands() {
    onChangeBands(Array.from({ length: 102 }, (_, i) => i + 1));
  }

  function prevDetector() {
    setActiveDetector((prev) => (prev === 1 ? 6 : prev - 1));
  }

  function nextDetector() {
    setActiveDetector((prev) => (prev === 6 ? 1 : prev + 1));
  }

  return (
    <div className="band-date-picker" aria-label="Band date picker">
      {/* Level 1: Calendar Month-Style Detector Header */}
      <div className="picker-detector-header">
        <button
          type="button"
          className="picker-nav-btn"
          aria-label="Previous detector"
          onClick={prevDetector}
        >
          ‹
        </button>
        <div className="picker-detector-title">
          <strong>{currentInfo.name}</strong>
          <small>{currentInfo.range}</small>
        </div>
        <button
          type="button"
          className="picker-nav-btn"
          aria-label="Next detector"
          onClick={nextDetector}
        >
          ›
        </button>
      </div>

      {/* 6-Detector Tab Bar */}
      <div className="picker-detector-strip" role="tablist" aria-label="Choose SPHEREx detector">
        {DETECTOR_INFO.map((det) => {
          const count = detectorBands(det.id).filter((b) => selectedBands.includes(b)).length;
          const isActive = activeDetector === det.id;
          return (
            <button
              key={det.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`picker-det-tab ${isActive ? 'active' : ''} ${count > 0 ? 'has-bands' : ''}`}
              onClick={() => setActiveDetector(det.id)}
            >
              <span className="det-tab-num">D{det.id}</span>
              {count > 0 && <span className="det-tab-badge">{count}</span>}
            </button>
          );
        })}
      </div>

      {/* Level 2: Calendar Day-Style 17-Band Grid */}
      <div className="picker-bands-grid" role="group" aria-label={`Bands in ${currentInfo.name}`}>
        {currentBands.map((band, idx) => {
          const isSelected = selectedBands.includes(band);
          const wl = getBandWavelength(band).toFixed(2);
          const localNum = String(idx + 1).padStart(2, '0');
          return (
            <button
              key={band}
              type="button"
              className={`picker-band-cell ${isSelected ? 'selected' : ''}`}
              aria-pressed={isSelected}
              aria-label={`Detector ${activeDetector}, Band ${idx + 1}, Global ${band}, ${wl} microns`}
              onClick={() => toggleBand(band)}
            >
              <span className="picker-band-local">{localNum}</span>
              <span className="picker-band-wl">{wl}µ</span>
              <span className="picker-band-global">#{band}</span>
            </button>
          );
        })}
      </div>

      {/* Quick Actions & Navigation Bar */}
      <div className="picker-actions-bar">
        <button
          type="button"
          className="picker-action-btn"
          onClick={toggleCurrentDetector}
        >
          {allInCurrentSelected ? `Deselect D${activeDetector}` : `Select all in D${activeDetector}`}
        </button>
        <button
          type="button"
          className="picker-action-btn survey-all-btn"
          onClick={selectAllSurveyBands}
        >
          All 102 bands
        </button>
      </div>

      {/* Selection Readout */}
      <div className="picker-selection-summary">
        <span>Active: <strong>{selectedBands.length}</strong> / 102 bands</span>
        <span className="picker-det-summary">
          {selectedInCurrent.length} in D{activeDetector}
        </span>
      </div>
    </div>
  );
}
