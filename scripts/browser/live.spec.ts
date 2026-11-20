import { test, expect } from '@playwright/test';

test('actual page: shared start, independent lifecycle, owned canvases, completion and restart', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Start both', exact: true })).toBeVisible();
  await expect(page.locator('.live-comparison canvas')).toHaveCount(0);
  await page.getByRole('button', { name: 'Start both', exact: true }).click();
  const gl = page.getByTestId('lane-webgl'), gpu = page.getByTestId('lane-webgpu');
  await expect(gl).toHaveAttribute('data-state', /complete|error|unsupported/, { timeout: 45000 });
  await expect(gpu).toHaveAttribute('data-state', /complete|error|unsupported/, { timeout: 45000 });
  expect(await gl.getAttribute('data-start')).toBe(await gpu.getAttribute('data-start'));
  expect(await gl.getAttribute('data-run')).toBe(await gpu.getAttribute('data-run'));
  await expect(gl).toHaveAttribute('data-state', 'complete');
  await expect(page.locator('canvas[aria-label="webgl live output"]')).toHaveCount(1);
  if (await gpu.getAttribute('data-state') === 'complete') {
    await expect(page.locator('canvas[aria-label="webgpu live output"]')).toHaveCount(1);
    await expect(page.getByTestId('completion-verdict')).toContainText(/finished first|Comparable/);
    await expect(page.getByTestId('completion-verdict')).toContainText('completion-time ratio');
    const vertices = page.locator('.live-comparison table tr').filter({ has: page.locator('td', { hasText: /^vertices$/ }) });
    const values = await vertices.locator('td').allTextContents(); expect(values[1]).toBe(values[2]);
    const indices = await page.locator('.live-comparison table tr').filter({ has: page.locator('td', { hasText: /^indices$/ }) }).locator('td').allTextContents();
    expect(indices[1]).toBe(indices[2]);
  } else await expect(page.getByTestId('completion-verdict')).toContainText('No valid');
  await expect(gl.locator('li[data-state="done"]')).toHaveCount(8);
  await expect(gl.locator('.live-native-log')).toContainText('drawElements');
  // Independently collected sustained cadence appears only after warm-up.
  await expect.poll(async () => Number((await page.locator('.live-comparison table tr').filter({ hasText: 'Steady FPS' }).locator('td').nth(1).textContent())?.replaceAll(',', '')), { timeout: 10000 }).toBeGreaterThan(0);
  const canvas = page.locator('canvas[aria-label="webgl live output"]');
  const screenshot = await canvas.screenshot();
  const lit = await page.evaluate(async base64 => {
    const img = new Image(); img.src = 'data:image/png;base64,' + base64; await img.decode();
    const copy = document.createElement('canvas'); copy.width = img.width; copy.height = img.height;
    const context = copy.getContext('2d')!; context.drawImage(img, 0, 0);
    const pixels = context.getImageData(img.width / 4, img.height / 4, img.width / 2, img.height / 2).data;
    let colored = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 2] > 65) colored++; return colored;
  }, screenshot.toString('base64'));
  expect(lit).toBeGreaterThan(100);
  await page.getByRole('button', { name: 'Freeze event view', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume event view' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume event view' }).click();
  const oldRun = await gl.getAttribute('data-run');
  await page.getByRole('button', { name: 'Restart both', exact: true }).click();
  await expect(gl).not.toHaveAttribute('data-run', oldRun!);
  await expect(gl).toHaveAttribute('data-state', /complete|error/, { timeout: 45000 });
  await expect(page.locator('canvas[aria-label="webgl live output"]')).toHaveCount(1);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  }
  expect(errors).toEqual([]);
});

test('unsupported WebGPU never delays or fakes WebGL completion', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { get: () => undefined }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Start both', exact: true }).click();
  await expect(page.getByTestId('lane-webgpu')).toHaveAttribute('data-state', 'unsupported');
  await expect(page.getByTestId('lane-webgl')).toHaveAttribute('data-state', 'complete', { timeout: 30000 });
  await expect(page.locator('canvas[aria-label="webgpu live output"]')).toHaveCount(0);
  await expect(page.getByTestId('completion-verdict')).toContainText('No valid');
});

test('rapid restart and mode unmount do not leave duplicate render canvases', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start both', exact: true }).click();
  await page.getByRole('button', { name: 'Restart both', exact: true }).click();
  await page.getByRole('button', { name: 'Restart both', exact: true }).click();
  await expect(page.getByTestId('lane-webgl')).toHaveAttribute('data-state', 'complete', { timeout: 45000 });
  await expect(page.locator('canvas[aria-label="webgl live output"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Educational pipeline', exact: true }).click();
  await expect(page.locator('canvas[aria-label="webgl live output"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Live comparison', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start both', exact: true })).toBeVisible();
  await expect(page.locator('.live-comparison canvas')).toHaveCount(0);
});

test('missing GL hardware timing stays unavailable while CPU rendering completes', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { get: () => undefined });
    const original = WebGL2RenderingContext.prototype.getExtension;
    WebGL2RenderingContext.prototype.getExtension = function(name: string) {
      if (name === 'EXT_disjoint_timer_query_webgl2') return null;
      return original.call(this, name);
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start both', exact: true }).click();
  await expect(page.getByTestId('lane-webgl')).toHaveAttribute('data-state', 'complete', { timeout: 30000 });
  await expect(page.locator('.live-comparison table tr').filter({ hasText: 'First-frame GPU draw pass' }).locator('td').nth(1)).toHaveText('Not available');
});

test('a WebGL shader-creation failure is isolated from the other lane', async ({ page }) => {
  await page.addInitScript(() => { WebGL2RenderingContext.prototype.createShader = () => { throw new Error('Injected shader failure'); }; });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start both', exact: true }).click();
  await expect(page.getByTestId('lane-webgl')).toHaveAttribute('data-state', 'error');
  await expect(page.getByTestId('lane-webgpu')).toHaveAttribute('data-state', /complete|unsupported|error/, { timeout: 45000 });
  await expect(page.getByTestId('completion-verdict')).toContainText('No valid');
});
