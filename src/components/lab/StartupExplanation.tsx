import { largestStartupGap } from '../../lib/live-explanations';
import type { LiveLane } from '../../lib/live-lifecycle';

const duration = (value: number | null) => value === null ? 'Хэмжилт алга' : `${value.toLocaleString('mn-MN', { maximumFractionDigits: 2 })} мс`;

export function StartupExplanation({ gl, gpu }: { gl: LiveLane; gpu: LiveLane }) {
  const gap = largestStartupGap(gl, gpu);
  const ready = gl.state === 'complete' && gpu.state === 'complete';
  const observed = gap ? (gap.gapMs === 0 ? 'Энэ хэсгийн хугацаа ижил байв.' : `WebGPU энэ хэсэгт ${duration(Math.abs(gap.gapMs))}-ээр ${gap.gapMs > 0 ? 'удаан' : 'хурдан'} байв.`) : '';
  return <section className="live-startup-explanation" aria-labelledby="startup-explanation-title">
    <h2 id="startup-explanation-title">WebGPU яагаад эхлэхдээ удаан байж болох вэ?</h2>
    <p>WebGPU нь GPU-тай ажиллах орчин үеийн API. WebGL-ийн зүгээр нэг шинэ хувилбар биш: ажлыг бэлдэх, илгээх арга нь өөр. Зарим ачаалалд давуу байж болно. Гэхдээ <strong>үргэлж хурдан гэсэн баталгаа байхгүй.</strong></p>
    <div className="live-startup-columns">
      <article><h3>1. Эхний зургийн бэлтгэл</h3><p>Нэг удаа кодоо ачаалж, GPU-тэй холбогдож, өгөгдөл ба зурах тохиргоогоо бэлдэнэ. Энэ бүхнийг эхний зургийн хугацаа багтаана.</p><dl><div><dt>WebGL</dt><dd>{duration(gl.metrics.completionMs)}</dd></div><div><dt>WebGPU</dt><dd>{duration(gpu.metrics.completionMs)}</dd></div></dl></article>
      <article><h3>2. Дараагийн зургууд</h3><p>Бэлэн болсон буфер, шэйдерээ дахин ашиглана. Доорх нь GPU таймер дэмжсэн үед хэмжсэн нэг зуралтын хугацаа; эхлэлийн нийт хугацаатай ижил утга биш.</p><dl><div><dt>WebGL</dt><dd>{duration(gl.metrics.gpuMs)}</dd></div><div><dt>WebGPU</dt><dd>{duration(gpu.metrics.gpuMs)}</dd></div></dl></article>
    </div>
    <p className="live-startup-reading">{ready && gap ? <><b>Энэ удаагийн хэмжилт:</b> сонгосон бэлтгэлийн хэсгүүдээс хамгийн их зөрсөн нь “{gap.label}”. {observed} Энэ нь ажигласан зөрүү; дангаараа дотоод шалтгааныг батлахгүй.</> : 'Хоёуланг эхлүүлсний дараа энд бэлтгэлийн аль хэсэг хамгийн их зөрснийг бодит хэмжилтээр харуулна. Одоогоор аль нэгийг удаан гэж дүгнээгүй.'}</p>
    <details><summary>Эхлэх үед ямар ажил хийгддэг вэ?</summary><ul>
      <li><b>Код бэлэн болох.</b> WebGPU-ийн Three.js код тусдаа ачаалагдана. Хадгалагдсан код бэлэн эсэх, бусад JavaScript ажиллаж байгаа эсэх хүлээлтэд нөлөөлнө.</li>
      <li><b>GPU-тэй ажиллах орчин нээх.</b> WebGL зурах орчин нээнэ. WebGPU дэмжигдэх GPU-г сонгон, төхөөрөмжийн холболт бэлдэнэ.</li>
      <li><b>Шэйдер ба зурах тохиргоо бэлдэх.</b> Шэйдер гэдэг нь байрлал, өнгө тооцох GPU програм. WebGPU үүнийг өгөгдлийн бүтэц, зургийн гаралттай нь нэг зурах тохиргоонд нэгтгэнэ. Бэлтгэх, шалгах ажил хугацаа авч болно.</li>
      <li><b>Үр дүнг мэдэгдэх.</b> GPU ажил дууссаныг браузер мэдэгдэнэ. Дохио ирэх саатал ч хэмжсэн нийт хугацаанд орно.</li>
    </ul><p>Эхлэхдээ удаан байсан ч дараагийн зуралтад хурдан байж болно. Бас хоёуланд нь удаан байж болно. Аль нь болохыг энэ төхөөрөмжийн хэмжилт л хэлнэ. Хоёр API нэг CPU/GPU-г хуваалцдаг тул нэг нь нөгөөгийн хугацаанд нөлөөлж болно.</p><p>Жишээ нь “төхөөрөмж бэлдэх” ба “шэйдер бэлдэх” хугацааг харьцуулж болно. Харин хүснэгтийн бүх мөрийг хооронд нь нэмж болохгүй: зарим хэмжилт нөгөө ажлынхаа дотор давхар ордог.</p><p className="lab-measure-note">Эх сурвалж: <a href="https://threejs.org/manual/pages/webgpurenderer" target="_blank" rel="noreferrer">Three.js-ийн WebGPU тайлбар</a> · <a href="https://developer.mozilla.org/en-US/docs/Web/API/GPUAdapter/requestDevice" target="_blank" rel="noreferrer">GPU төхөөрөмж бэлдэх</a> · <a href="https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/createRenderPipelineAsync" target="_blank" rel="noreferrer">Зурах тохиргоо бэлдэх</a></p></details>
  </section>;
}
