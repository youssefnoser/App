import { test, expect } from '@playwright/test';

test('Sky controls and band selection work without hydration errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => {
    if (!error.message.includes('memory access out of bounds')) errors.push(error.message);
  });
  await page.goto('/');
  await expect(page.getByRole('slider', { name: 'Observation frame' })).toBeVisible();
  await page.getByRole('button', { name: 'Choose infrared bands' }).click();
  await page.getByRole('checkbox', { name: 'Detector 1, local band 2, global band 2', exact: true }).check();
  await expect(page.locator('#band-status')).toContainText('2 individual bands');
  await page.screenshot({ path: 'test-results/desktop-bands-large-picker.png' });
  await page.getByRole('button', { name: 'Close band selection' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/demo-mobile.png' });
  expect(errors).toEqual([]);
});

test('Stellarium canvas renders, target crosshair displays, and features function properly', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => {
    if (!error.message.includes('memory access out of bounds')) errors.push(error.message);
  });

  await page.goto('/');

  // 1. Canvas presence
  const canvas = page.locator('#stel-canvas');
  await expect(canvas).toBeVisible();

  // 2. Target crosshair and label
  const label = page.locator('#object-label');
  await expect(label).toBeVisible();
  await expect(label).toContainText("Barnard’s Star");

  // 3. Coordinate display
  const coordDisplay = page.locator('.map-coordinate');
  await expect(coordDisplay).toContainText('269.4521°');

  // 4. Grid toggle
  const gridButton = page.getByRole('button', { name: 'Toggle coordinate grid' });
  await expect(gridButton).toHaveAttribute('aria-pressed', 'true');
  await gridButton.click();
  await expect(gridButton).toHaveAttribute('aria-pressed', 'false');
  await gridButton.click();
  await expect(gridButton).toHaveAttribute('aria-pressed', 'true');

  // 5. Target selection from search popover (starts small, grows when focused)
  const searchDock = page.locator('.search-dock');
  const initialBox = await searchDock.boundingBox();
  expect(initialBox?.width).toBeLessThanOrEqual(230);

  const searchInput = page.getByLabel('Search celestial objects');
  await searchInput.focus();
  await expect(page.locator('#sky-search-options')).toBeVisible();
  await expect(searchDock).toHaveClass(/is-searching/);

  // Smooth CSS expansion transition completes
  await expect.poll(async () => (await searchDock.boundingBox())?.width).toBeGreaterThanOrEqual(400);
  await page.screenshot({ path: 'd:/coding/integration/nasa/test-results/desktop-search-dock-space-icons.png' });

  await page.getByRole('button', { name: /Epsilon Indi B/ }).click();
  await expect(label).toContainText('Epsilon Indi B');
  await expect(coordDisplay).toContainText('330.8417°');

  // 6. Timeline frame advance
  await page.getByRole('button', { name: 'Next frame' }).click();
  await expect(page.locator('.time-section')).toContainText('December 2025');

  // 7. Frames toggle in the map toolbar: hiding the frames leaves the all-sky map.
  const framesBtn = page.getByRole('button', { name: 'Show SPHEREx frames' });
  await expect(framesBtn).toHaveAttribute('aria-pressed', 'true');
  await framesBtn.click();
  await expect(framesBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText('SPHEREx frames hidden')).toBeVisible();
  await framesBtn.click();
  await expect(framesBtn).toHaveAttribute('aria-pressed', 'true');

  // 8. Straight zoom ruler: arrow keys step 1.25 times, Home is the deepest zoom.
  const ruler = page.getByRole('slider', { name: 'Field of view' });
  const fieldReadout = page.locator('.field-ruler-readout');
  await expect(ruler).toBeVisible();
  await expect(fieldReadout).toContainText('5.0′');
  await ruler.focus();
  await page.keyboard.press('ArrowUp');
  await expect(fieldReadout).toContainText('4.0′');
  await page.keyboard.press('ArrowDown');
  await expect(fieldReadout).toContainText('5.0′');
  await page.keyboard.press('PageDown'); // 5′ × 1.25^4
  await expect(fieldReadout).toContainText('12′');
  await page.screenshot({ path: 'test-results/desktop-zoom-out-wide.png' });
  await page.keyboard.press('Home');
  await expect(fieldReadout).toContainText('12″');
  await page.screenshot({ path: 'test-results/desktop-zoom-in-deep.png' });

  // 9. Recenter button
  await page.getByRole('button', { name: 'Recenter map' }).click();
  await page.screenshot({ path: 'test-results/desktop-google-maps-zoom.png' });

  expect(errors).toEqual([]);
});

test('Advanced analysis tools: band comparison and image math display correctly', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => {
    if (!error.message.includes('memory access out of bounds')) errors.push(error.message);
  });

  await page.goto('/');

  // 1. Open Advanced options drawer
  const advToggle = page.getByRole('button', { name: 'Open advanced options' });
  await expect(advToggle).toBeVisible();
  await advToggle.click();

  const sidebar = page.locator('#image-math-sidebar');
  await expect(sidebar).toBeVisible();

  // 2. Check Dual-Band Compare tab (default active tab)
  await expect(page.locator('.band-compare-panel')).toBeVisible();
  await expect(sidebar).toContainText('FLUX RATIO');
  await expect(page.locator('.split-viewport')).toBeVisible();

  // 3. Check Image Math tab and Date-Picker Style Band Chooser
  await page.getByRole('button', { name: 'Image Math' }).click();
  await expect(sidebar).toContainText('Compare observations to reveal changes over time');

  // Select "Add frames" operation
  const opSelect = page.getByLabel('Image operation');
  await opSelect.selectOption('add');
  await expect(page.locator('.math-band-picker-container')).toBeVisible();

  // Pick Detector 2 using the calendar detector strip
  const d2Tab = page.getByRole('tab', { name: /D2/ });
  await d2Tab.click();
  await expect(d2Tab).toHaveClass(/active/);
  await expect(sidebar).toContainText('Detector 2');
  await expect(sidebar).toContainText('1.11 – 1.64 µm');

  // Select all bands in Detector 2
  await page.getByRole('button', { name: 'Select all in D2' }).click();
  await expect(sidebar).toContainText('17 in D2');
  await expect(sidebar).toContainText('18 / 102 selected');

  // Take screenshot of Image Math with Date-Picker band selection
  await page.screenshot({ path: 'test-results/desktop-image-math-band-picker.png' });

  // Close sidebar
  await page.getByRole('button', { name: 'Close advanced options', exact: true }).click();
  await expect(sidebar).not.toBeVisible();

  // 4. Test Quick Map Overlays for Gaia & WISE
  const gaiaMapBtn = page.getByRole('button', { name: 'Toggle Gaia DR3 overlay' });
  const wiseMapBtn = page.getByRole('button', { name: 'Toggle WISE overlay' });
  await gaiaMapBtn.click();
  await expect(page.locator('.catalog-pin.gaia-pin')).toBeVisible();
  await wiseMapBtn.click();
  await expect(page.locator('.catalog-pin.wise-pin')).toBeVisible();

  // Toggle off
  await gaiaMapBtn.click();
  await expect(page.locator('.catalog-pin.gaia-pin')).not.toBeVisible();
  await wiseMapBtn.click();
  await expect(page.locator('.catalog-pin.wise-pin')).not.toBeVisible();

  expect(errors).toEqual([]);
});

test('Search history persists searches, allows restoration, individual deletion, and clear all', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => {
    if (!error.message.includes('memory access out of bounds')) errors.push(error.message);
  });

  await page.goto('/');

  const searchInput = page.getByLabel('Search celestial objects');

  // Initially search dock opens without history
  await searchInput.click();
  await expect(page.locator('.search-history-container')).not.toBeVisible();

  // Search a celestial target (e.g. Epsilon Indi B)
  await page.getByRole('button', { name: /Epsilon Indi B/ }).click();
  const label = page.locator('#object-label');
  await expect(label).toContainText('Epsilon Indi B');

  // Search a coordinate pair
  await searchInput.click();
  await searchInput.fill('180.25, 45.12');
  await searchInput.press('Enter');
  const coordDisplay = page.locator('.map-coordinate');
  await expect(coordDisplay).toContainText('180.2500°');

  // Open search again - history container must now be visible with 2 items
  await searchInput.click();
  const historyContainer = page.locator('.search-history-container');
  await expect(historyContainer).toBeVisible();
  await expect(historyContainer.locator('.search-history-row')).toHaveCount(2);

  // Take screenshot of search history
  await page.screenshot({ path: 'test-results/desktop-search-history.png' });

  // Click the earlier history item (Epsilon Indi B) to restore it
  const epsHistoryBtn = historyContainer.getByRole('button', { name: /Epsilon Indi B/ }).first();
  await epsHistoryBtn.click();
  await expect(label).toContainText('Epsilon Indi B');

  // Re-open search to test individual item delete
  await searchInput.click();
  await expect(historyContainer).toBeVisible();
  const deleteBtn = page.getByRole('button', { name: /Delete .* from history/ }).first();
  await deleteBtn.click();
  await expect(historyContainer.locator('.search-history-row')).toHaveCount(1);

  // Test Clear all
  const clearAllBtn = page.getByRole('button', { name: 'Clear all' });
  await clearAllBtn.click();
  await expect(historyContainer).not.toBeVisible();

  expect(errors).toEqual([]);
});
