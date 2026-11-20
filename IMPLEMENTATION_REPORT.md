# Live first-frame WebGL / WebGPU comparison

The primary screen answers **which implementation made its first rendered frame available sooner from one common user-triggered start**, rather than comparing two educational animation durations. No actual hardware winner is claimed in this report because browser execution is blocked in the implementation environment.

## What was preserved

The Vite / React / Three.js structure, graphite/blue/violet design, object explorer, materials, orbit/zoom, responsive layouts, fullscreen, six Mongolian educational explanations and original benchmark/history/CSV functionality remain. The previous slow-motion engine is retained in **Educational pipeline**. Its controls and optional isolated/concurrent complexity benchmarks remain there; that engine is not mounted or rendering during live comparison.

## Primary workflow

1. Choose the native Cube, Sphere, Torus, Torus knot or instanced particle object. Optional sphere workloads have exact 1K / 10K / 50K / 100K / 500K position counts. Select an equal drawing-buffer resolution for both.
2. **Start both** records one timestamp, prepares canonical source geometry once, and launches the two initialization tasks using `Promise.allSettled` coordination without awaiting a sibling.
3. Each lane independently creates its context/device, scene, camera, copied typed buffers, material, controls and render target; it compiles/prepares its shader pipelines and submits its own first frame.
4. Each independently observes its own completion signal. WebGL uses `fenceSync` / `flush` / nonblocking `clientWaitSync`; WebGPU uses `queue.onSubmittedWorkDone`. The finished lane publishes immediately and proceeds to its own warm-up/render loop without a peer-stage barrier.
5. Once both successful first-frame signals exist, the verdict shows absolute difference, percentage less time, completion-time ratio and first finisher, or **Comparable within observation tolerance**.
6. After each lane's 1.5-second warm-up, sustained mean/median/p95 frame intervals, FPS, frame counts and optional hardware GPU samples update independently. **Freeze event view** freezes displayed events only; actual rendering and measurement continue.

Workload/material changes initiate a new common-start experiment. **Restart both** invalidates older asynchronous work and replaces owned resources. **Export run JSON** downloads raw milestones, native API call observations, metrics, conditions and verdict for the displayed run.

## Architecture and ownership

- `src/lib/live-controller.ts`: common start, immutable-by-convention canonical source, independent asynchronous initialization, per-lane owned rendering resources, API tracing, GPU fences/timers, warm-up and steady loops, restart/visibility/disposal handling.
- `src/lib/live-lifecycle.ts`: lifecycle/event types, observable milestones, percent/ratio/tolerance calculation, quantiles and independent task launcher.
- `src/components/lab/LiveComparison.tsx`: common controls, two outputs, independent event lanes, comparison table, first-frame verdict and JSON export.
- `src/components/lab/PipelineLab.tsx` and `pipeline-lab.css`: additive integration using the preserved explorer/design and educational mode.
- `src/lib/pipeline-engine.ts`, `pipeline.ts`, `pipeline-content.ts`: retained slow-motion visualization, matched-workload benchmarks, geometry and explanations.
- `src/lib/frame-meter.ts`: per-renderer cadence/CPU accumulator.
- `scripts/pipeline.test.mjs`: core math, ownership/copy contract, comparison logic and task-independence tests.
- `scripts/browser/live.spec.ts`, `playwright.config.ts`: actual-page browser checks.

Canonical geometry is prepared once; `BufferGeometry.clone()` creates independent position/normal/index typed arrays for the two paths. Rendering never shares a mutable scene, camera, material or geometry between APIs. Camera controls broadcast pose values to the other owned camera after initialization; devices/contexts/resources remain separate. Instanced particles use matching tetrahedron marker geometry and instance transforms; their source positions are separate from marker triangle counts.

**Concurrency qualification:** both tasks have a common logical start and overlap asynchronous API/GPU work; neither awaits the other's stages or completion. Main-thread JavaScript executes serially. Browser/driver/GPU scheduling may serialize commands or share hardware resources. This implementation does not claim physically parallel CPU threads or guaranteed simultaneous GPU execution.

## Observable events versus conceptual stages

The live lanes show actual milestones: common geometry preparation, renderer module readiness, context/device initialization, owned data copying, `compileAsync` readiness, first draw/encoding/submission, completion notification and frame availability. Progress is a count of completed milestones, not an invented percentage or fixed-duration animation. Fast milestones can complete before the browser paints an intermediate state; their actual timestamps and call records remain inspectable.

Startup tracing wraps exposed native methods when writable:

- WebGL: buffer creation/binding/data calls, attribute configuration, shader creation/source/compilation, program creation/linking and draw calls.
- WebGPU: buffer creation, queue writes, shader modules, bind groups/layouts, render pipeline creation, command encoder creation, render pass commands, finishing and queue submission.

Each row records actual observed call count, CPU method duration and first/last timestamps. Unsupported/unwrappable methods remain **Not available**. Hooks are removed after startup to avoid adding their per-call overhead to sustained frame metrics. Instrumentation itself still affects startup, and the APIs have different observable method boundaries.

Vertex processing, primitive assembly, rasterization and fragment execution inside a submitted draw are **not individually observable browser events**. They remain conceptual explanations, with WebGL/WGSL distinctions, input/output formulas and CPU/API/GPU notes. No six-second durations are assigned to them in live mode. WebGPU command encoding is CPU/API work, not a GPU shader stage.

## Timing methodology

| Measurement | Actual boundary |
| --- | --- |
| Common CPU geometry | One timed canonical geometry construction; legitimately shared once |
| Owned CPU preparation | Separate per-lane scene, buffer-array and instance copying |
| Module wait | Remaining renderer-module await wall time, including main-thread scheduling delay; WebGPU code is preloaded before Start when possible |
| Device/context | Constructor and actual device initialization wall time |
| Shader/pipeline readiness | `compileAsync` wall time, including the renderer/browser readiness mechanism |
| Shader/pipeline API | Sum of observed native CPU call times; async pipeline-call return time is not hardware compile duration |
| Buffer/attribute API | Sum of observed native buffer/data/attribute CPU calls; not separately timed GPU DMA/upload execution |
| Command encoding | WebGPU encoder/pass/finish CPU method observations; WebGL has no equivalent encoder measurement |
| Native submission | GL draw-call or WebGPU queue-submit CPU time |
| First render CPU | Full first `renderer.render()` duration, including tracing overhead |
| Initialization | Common start until shader/pipeline readiness |
| GPU completion wait | Wall time from first submission to observed fence/queue signal |
| Total / first frame available | Common start until that successful GPU completion signal is observed |
| Hardware GPU pass | Optional first-frame and sustained GPU render-pass timer queries; never inferred from CPU duration |
| Sustained interval/FPS | Each lane's own successful RAF submissions after warm-up; not confirmed compositor presentations or uncapped hardware throughput |
| Median / p95 | Latest up to 240 measured frame intervals |

These overlapping measurements **must not be added together**. A GL fence/queue signal means submitted work completed, not that the browser compositor displayed the image. Browser presentation latency, individual internal hardware stage durations, GPU utilization and VRAM are not exposed here.

GPU timings use `EXT_disjoint_timer_query_webgl2` or Three.js WebGPU `trackTimestamp` / `resolveTimestampsAsync` when supported. Missing extensions/features show **Not available**. Disjoint GL samples are discarded; delayed query results are polled without synchronously blocking the GPU. Optional query failure does not replace a real GPU value with CPU timing. Initial readiness and first output are still observable without GPU timestamp support.

## Verdict and fairness

Both initialize from one common logical timestamp, receive equivalent position/index data, opaque PBR settings, lighting, initial model transform, camera pose/FOV and equal drawing-buffer resolution. DPR is 1, antialiasing/alpha are off in both. Three.js adapts the API depth conventions without changing projected X/Y or camera pose. Color space, tone mapping and exposure match. Shader compilers/backend precision can still produce small output differences; bit-identical pixels are not promised.

The primary comparison is **contended startup of this instrumented application**, including common preparation, remaining module wait and main-thread scheduling. It is not an isolated intrinsic GPU/API speed test. One lane's continuous rendering may overlap the peer's remaining initialization. Module/cache state, compile polling, browser timer granularity, fence-notification delay, thermal state and external workloads influence results. Use the retained isolated/repeated benchmark for sustained workload research; do not turn one startup result into a universal claim.

For positive totals `fast` and `slow`, difference = `slow - fast`, percentage less observed time = `(slow - fast) / slow × 100`, ratio = `slow / fast`. No API is favored. A winner is declared only beyond `max(2 ms, 2 × each observed fence-poll delay, 2% of the smaller total)`. This conservative observation threshold is **not a statistical significance test**. The table shows raw differences but makes no per-metric statistical winner claims. Failures, unavailable signals or mismatched run IDs/start timestamps produce no two-API winner.

## Validation actually obtained

- TypeScript: PASS.
- Production build: PASS (existing Three.js chunk-size/dependency directive warnings remain).
- Unit/math suite: **25 tests pass**. Includes canonical copy independence, both tasks launching before either settles, failure isolation, winner symmetry, tolerance/notification handling, median/p95, frame meters, 500K indices and educational math.
- `npm run test:browser`: **BLOCKED before browser launch** — local server failed with `listen EPERM: operation not permitted 127.0.0.1:5178`.
- Actual rendering, first-frame signals, GPU query values, event-hook coverage, responsive appearance and driver resource behavior: **NOT VERIFIED here**.
- Actual hardware benchmark numbers / winner: **none obtained; none invented**.

The five browser cases target the actual page: shared start/run identifiers and actual output pixels, completion/cadence, unavailable WebGPU with independent WebGL completion, rapid restarts/mode unmount, unavailable hardware timing, and isolated shader failure. They are provided but have not passed in this restricted environment. Native API instrumentation and asynchronous renderer disposal need validation on the seminar device before making hardware claims.

## Local browser validation

```sh
npm install
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

`CHROME_PATH` can select an installed Chromium. Browser checks use port 5178 and ignored `test-results/` / `playwright-report/` artifacts. WebGL needs WebGL 2; WebGPU needs a secure context, exposed API and successful actual backend initialization. A Three.js WebGL fallback is rejected rather than mislabeled. GPU timer support is checked separately.
