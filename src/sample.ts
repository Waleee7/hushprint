// Builds demo files in the browser: real canvas-rendered images carrying fictional, planted metadata.
import { ascii, concat } from './engine/bytes.ts';
import { injectMetadata, injectWebp, pngChunk, syntheticOffice, syntheticPdf } from './engine/fixtures.ts';

const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const W = 1600, H = 1200;

const drawScene = (): HTMLCanvasElement => {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, H * 0.7);
  sky.addColorStop(0, '#2b3a67'); sky.addColorStop(0.55, '#e0707a'); sky.addColorStop(1, '#ffc074');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  g.fillStyle = '#fff4d6'; g.beginPath(); g.arc(520, 640, 110, 0, 7); g.fill();
  g.fillStyle = '#3a2f5b'; g.beginPath(); g.moveTo(0, 760); g.bezierCurveTo(300, 600, 600, 700, 900, 640); g.bezierCurveTo(1200, 580, 1400, 700, W, 650); g.lineTo(W, H); g.lineTo(0, H); g.fill();
  g.fillStyle = '#233a2c'; g.fillRect(0, 800, W, H - 800);
  // house
  g.fillStyle = '#f3e6cf'; g.fillRect(560, 560, 440, 280);
  g.fillStyle = '#a2453f'; g.beginPath(); g.moveTo(520, 570); g.lineTo(780, 400); g.lineTo(1040, 570); g.fill();
  g.fillStyle = '#ffd36b'; for (const x of [600, 860]) g.fillRect(x, 620, 100, 90);
  g.fillStyle = '#5a3a2a'; g.fillRect(745, 700, 70, 140);
  // tree
  g.fillStyle = '#4a3326'; g.fillRect(290, 640, 34, 210);
  g.fillStyle = '#2f6b45'; g.beginPath(); g.arc(307, 600, 120, 0, 7); g.fill();
  // mailbox with house number, deliberately outside the cropped photo
  g.fillStyle = '#44464f'; g.fillRect(1428, 760, 14, 150);
  g.fillStyle = '#f6f6f2'; g.fillRect(1340, 700, 190, 76);
  g.fillStyle = '#12131a'; g.font = '700 54px sans-serif'; g.textAlign = 'center'; g.fillText('412', 1435, 752);
  g.font = '600 20px sans-serif'; g.fillText('PEACH LN', 1435, 772 - 2);
  return c;
};

const toBytes = (c: HTMLCanvasElement, type: string, q?: number) =>
  new Promise<Uint8Array>((res, rej) => c.toBlob(async (b) => (b ? res(new Uint8Array(await b.arrayBuffer())) : rej(new Error('canvas export failed'))), type, q));

const crop = (src: HTMLCanvasElement, x: number, y: number, w: number, h: number, outW: number, outH: number) => {
  const c = document.createElement('canvas'); c.width = outW; c.height = outH;
  c.getContext('2d')!.drawImage(src, x, y, w, h, 0, 0, outW, outH);
  return c;
};

export const makeSampleFiles = async (): Promise<File[]> => {
  const scene = drawScene();
  // The photo was cropped (3:2, mailbox gone) but the camera's embedded thumbnail still shows the full 4:3 frame.
  const thumb = await toBytes(crop(scene, 0, 0, W, H, 160, 120), 'image/jpeg', 0.8);
  const main = await toBytes(crop(scene, 120, 260, 1200, 800, 1200, 800), 'image/jpeg', 0.86);
  const photo = injectMetadata(main, {
    lat: 33.78533, lon: -84.37381, altitude: 301, heading: 74,
    make: 'Apple', model: 'iPhone 15 Pro', lens: 'iPhone 15 Pro back triple camera 6.765mm f/1.78', serial: 'DEMO-SN-7Q4K2M9X',
    owner: 'Jordan Rivera', software: '17.5.1', taken: '2026:06:08 18:42:07', orientation: 1, makerNote: true, thumbnail: thumb,
    xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="Photos 9.0" xmp:CreateDate="2026-06-08T18:42:07"><dc:creator><rdf:Seq><rdf:li>Jordan Rivera</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>',
  });

  const art = await toBytes(crop(scene, 400, 300, 800, 600, 640, 480), 'image/png');
  const extra = concat([
    pngChunk('tEXt', ascii('Software\0Stable Diffusion WebUI 1.9')),
    pngChunk('tEXt', ascii('parameters\0golden hour house with big tree, 8k, photoreal --seed 48211937 --steps 30 --model dreamshaper_v8')),
    pngChunk('tEXt', ascii('Author\0Jordan Rivera')),
    pngChunk('tIME', Uint8Array.of(0x07, 0xea, 6, 9, 21, 5, 44)),
  ]);
  const leftover = ascii(`aCropalypse demo: this is where an editor can leave the uncropped original. ${'x'.repeat(2400)}`);
  const png = concat([art.subarray(0, 33), extra, art.subarray(33), leftover]);

  const files = [
    new File([photo as BlobPart], 'birthday-yard.jpg', { type: 'image/jpeg' }),
    new File([png as BlobPart], 'ai-render.png', { type: 'image/png' }),
  ];
  const webpRaw = await toBytes(crop(scene, 0, 300, 1000, 750, 640, 480), 'image/webp', 0.8).catch(() => undefined);
  if (webpRaw && webpRaw[0] === 0x52) { // 'R' of RIFF: this browser can encode WebP
    const webp = injectWebp(webpRaw, { exif: { lat: 33.78533, lon: -84.37381, make: 'Google', model: 'Pixel 8', serial: 'DEMO-PX-3381', taken: '2026:06:09 08:15:44' } });
    files.push(new File([webp as BlobPart], 'listing-photo.webp', { type: 'image/webp' }));
  }
  const pdf = await syntheticPdf({ info: { Author: 'Jordan Rivera', Creator: 'Microsoft Word', Producer: 'Microsoft Word for Microsoft 365', Title: 'Offer letter - draft 3', CreationDate: "D:20260608143211-04'00'", ModDate: "D:20260610091500-04'00'" },
    xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="Microsoft Word"><dc:creator><rdf:Seq><rdf:li>Jordan Rivera</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>' });
  const docx = syntheticOffice({ kind: 'docx', creator: 'Jordan Rivera', lastModifiedBy: 'Sam Patel', company: 'Peachtree Holdings', manager: 'Dana Cole', created: '2026-06-08T14:32:11Z', modified: '2026-06-10T09:15:00Z',
    revision: '14', application: 'Microsoft Office Word', template: 'Normal.dotm', totalTime: '212', title: 'Q3 reorg plan', thumbnail: true });
  files.push(new File([pdf as BlobPart], 'offer-letter.pdf', { type: 'application/pdf' }), new File([docx as BlobPart], 'q3-plan.docx', { type: MIME_DOCX }));
  return files;
};
