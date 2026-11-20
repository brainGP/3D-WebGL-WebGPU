# Web Graphics Lab

An interactive educational benchmark comparing Three.js `WebGLRenderer` (WebGL 2) and `WebGPURenderer` (WebGPU). The same instanced-cube scene, camera defaults, animation, canvas size, and test protocol are used for each run. WebGPU fallback is detected and is never recorded as a WebGPU result.

## Run locally

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. WebGL 2 is the broadly supported option. WebGPU availability depends on the browser, operating system, and graphics adapter.

## Run a fair comparison

1. Choose an instance count and measurement duration.
2. Select a renderer and choose **Run benchmark**.
3. Allow the two-second warm-up and timed capture to finish.
4. Choose **Record result**.
5. Run the other renderer with the same settings. Compare selected rows only when object count, requested duration, and drawing-buffer resolution match.
6. Repeat several times. Export the recorded measurements as CSV for reporting.

Each run initializes the selected renderer with the same camera, geometry, material, lighting, animation, and controls. The app records the actual drawing-buffer resolution and measured capture duration. FPS and frame time are computed from captured frame intervals; draw calls, triangles, and points come from Three.js renderer statistics. Unsupported values are shown as N/A.

Browser, GPU, drivers, power mode, temperature, display refresh rate, and background applications can affect results. This benchmark describes one workload on one system; it does not establish that either API is always faster. WebGPU compute features are not exercised by this rendering test.

## Project commands

```bash
npm run typecheck
npm run build
npm run preview
```

Benchmark history is saved in this browser's local storage. CSV exports contain recorded measurements, not estimated or preset results.

## Live first-frame comparison

The main screen now starts with **Start both**. It prepares canonical geometry once and launches independent WebGL/WebGPU initialization tasks from a common timestamp without awaiting either peer. Each path owns its scene, camera, copied typed buffers, material, context/device and render loop.

The two live lanes follow observable events and actual native API calls: setup, buffer/attribute preparation, shader/pipeline readiness, command submission, GPU completion notification and output availability. Internal vertex/raster/fragment stages are conceptual explanations, not fixed-duration hardware events.

The verdict reports **which finished first, absolute milliseconds, percentage less observed time and completion-time ratio**, or comparable results within an observation tolerance. Completion means a GL fence or WebGPU queue signal was observed, not browser presentation. The primary result is contended instrumented startup; it is not a universal API ranking.

The table separates CPU preparation, API call durations, initialization, first-frame availability, optional hardware GPU time and sustained frame metrics. After each lane's independent 1.5-second warm-up, FPS, mean/median/p95 intervals and frame counts update independently. Missing hardware timing reads **Not available**. No GPU utilization or internal-stage timing is invented. Export the raw run as JSON.

**Educational pipeline** preserves the prior 36-second slow-motion controls, mesh representations, Mongolian explanations, pixel lab and isolated/concurrent complexity benchmarks. That engine does not run alongside live comparison. The original cube benchmark, saved history and CSV export remain in **Нэмэлт хэмжилт**.

```sh
npm test                     # 27 core measurement/geometry/coordination tests
npm run typecheck
npm run build
npx playwright install chromium
npm run test:browser          # Actual-page browser checks; port 5178
```

Use Node 22.6+ for core tests. Browser tests were blocked by local-server `EPERM` in the implementation environment. No actual hardware completion times or winner have been obtained here. See [IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md) for exact boundaries, fairness limits, architecture and validation status.
# 3D-WebGL-WebGPU

## Монгол тайлбар

Үндсэн дэлгэцийн товч, явц, хүснэгтүүд монгол тайлбартай. CPU, GPU, API, буфер, шэйдер, FPS, медиан, p95 зэрэг үгийг **Нэр томьёог энгийнээр** хэсгээс харна. Бодитоор ажигласан API функц бүрийн нэрийн дор хийх ажлыг нь товч тайлбарласан.

Объект зураг болох зургаан алхмыг энгийнээр тайлбарлав:

1. Цэгүүдийг бэлдэх.
2. Цэгүүдийн байрлалыг тооцох.
3. Цэгүүдийг гурвалжин болгох.
4. Гурвалжинг дэлгэцийн жижиг нүднүүдэд хуваах.
5. Өнгө ба гэрэл тооцох.
6. Бэлэн зургийг хадгалах.

**WebGPU яагаад эхлэхдээ удаан байж болох вэ?** хэсэг нь нэг удаагийн эхлэлийн бэлтгэлийг дараагийн зуралтын хугацаанаас ялгаж харуулна. Хэмжилт хийсний дараа сонгосон бэлтгэлийн хэсгүүдээс хамгийн их зөрсөн хэсгийг бодит тоогоор үзүүлнэ. Энэ нь ажигласан зөрүү болохоос дотоод шалтгааны баталгаа биш. WebGPU үргэлж хурдан гэж үзэхгүй; WebGL хурдан гарсан үр дүнг мөн хэвээр харуулна.
