'use client';

import { ChangeEvent, DragEvent, useEffect, useRef, useState } from 'react';

type PreserveKey = 'pose' | 'background' | 'lighting' | 'outfit';
type PhotoType = 'original' | 'reference';

const options: { key: PreserveKey; label: string; detail: string }[] = [
  { key: 'pose', label: 'Same pose', detail: 'Keep the subject position' },
  { key: 'background', label: 'Same background', detail: 'Keep the original scene' },
  { key: 'lighting', label: 'Same lighting & vibe', detail: 'Keep its atmosphere' },
  { key: 'outfit', label: 'Same outfit', detail: 'Keep their clothing' }
];

function fileIsValid(file: File) {
  return file.type.startsWith('image/') && file.size <= 10 * 1024 * 1024;
}

export default function Home() {
  const [files, setFiles] = useState<Record<PhotoType, File | null>>({ original: null, reference: null });
  const [previews, setPreviews] = useState<Record<PhotoType, string | null>>({ original: null, reference: null });
  const [preserve, setPreserve] = useState<Record<PreserveKey, boolean>>({ pose: true, background: false, lighting: true, outfit: false });
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'analyzing' | 'editing' | 'error'>('idle');
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const inputRefs = useRef<Record<PhotoType, HTMLInputElement | null>>({ original: null, reference: null });

  useEffect(() => () => Object.values(previews).forEach((url) => url && URL.revokeObjectURL(url)), [previews]);

  function setPhoto(kind: PhotoType, selected?: File) {
    if (!selected) return;
    if (!fileIsValid(selected)) { setError('Choose an image file up to 10 MB.'); return; }
    setError('');
    setFiles((current) => ({ ...current, [kind]: selected }));
    setPreviews((current) => {
      if (current[kind]) URL.revokeObjectURL(current[kind]!);
      return { ...current, [kind]: URL.createObjectURL(selected) };
    });
    setResult(null);
  }

  function onDrop(event: DragEvent<HTMLButtonElement>, kind: PhotoType) {
    event.preventDefault();
    setPhoto(kind, event.dataTransfer.files[0]);
  }

  // Mobile-Friendly Download Handler (converts remote URL to local Blob)
  async function handleDownload(imageUrl: string) {
    try {
      setDownloading(true);
      const res = await fetch(imageUrl);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `reframe-edit-${Date.now()}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch {
      // Fallback: Opens image directly if browser blocks automatic blob download
      window.open(imageUrl, '_blank');
    } finally {
      setDownloading(false);
    }
  }

  async function createEdit() {
    if (!files.original || !files.reference) { setError('Add both your original and reference image first.'); return; }
    if (!Object.values(preserve).some(Boolean)) { setError('Choose at least one detail to preserve.'); return; }
    setError(''); setResult(null); setStatus('analyzing');
    
    try {
      // Compress images client-side before sending to prevent Vercel 4.5MB limits
      const optimizedOriginal = await prepareImageForUpload(files.original);
      const optimizedReference = await prepareImageForUpload(files.reference);

      const data = new FormData();
      data.append('original', optimizedOriginal);
      data.append('reference', optimizedReference);
      data.append('preserve', JSON.stringify(preserve));

      const response = await fetch('/api/edit', { method: 'POST', body: data });
      
      // Safe text-first parsing (prevents "Unexpected token R" JSON crash)
      const responseText = await response.text();
      let payload: any;
      try {
        payload = JSON.parse(responseText);
      } catch {
        throw new Error(`Server Error (${response.status}): Payload limit exceeded or invalid response.`);
      }

      if (!response.ok) throw new Error(payload.error || 'We could not create this edit.');
      
      setPrompt(payload.prompt); setStatus('editing');
      await new Promise((resolve) => setTimeout(resolve, 450));
      setResult(payload.image); setStatus('idle');
    } catch (requestError) {
      setStatus('error'); setError(requestError instanceof Error ? requestError.message : 'Something went wrong.');
    }
  }

  const busy = status === 'analyzing' || status === 'editing';

  return (
    <main>
      <nav><a className="brand" href="#top"><span>R</span> Reframe</a><div className="nav-note">Reference-led edits</div></nav>
      <section className="hero" id="top"><p className="eyebrow">NO PROMPTS. JUST TASTE.</p><h1>Copy the look,<br /><i>keep the you.</i></h1><p>Give us your photo and an edited reference. Choose what stays yours—we’ll translate the rest.</p></section>
      <section className="studio" aria-label="Image editing studio">
        <div className="step-title"><span>01</span><div><h2>Start with two images</h2><p>Your original stays private. The reference can be any AI edit or screenshot.</p></div></div>
        <div className="upload-grid">
          {(['original', 'reference'] as PhotoType[]).map((kind) => <div className="upload-wrap" key={kind}>
            <label>{kind === 'original' ? 'Your original' : 'Your reference'}<em>{kind === 'original' ? 'SOURCE' : 'LOOK'}</em></label>
            <button className={`dropzone ${previews[kind] ? 'has-image' : ''}`} onClick={() => inputRefs.current[kind]?.click()} onDrop={(event) => onDrop(event, kind)} onDragOver={(event) => event.preventDefault()}>
              {previews[kind] ? <img src={previews[kind]!} alt={`${kind} preview`} /> : <><span className="upload-icon">↥</span><strong>Drop image here</strong><small>or tap to browse · JPG, PNG, WEBP</small></>}
              {previews[kind] && <span className="replace">Replace</span>}
            </button>
            <input ref={(node) => { inputRefs.current[kind] = node; }} type="file" accept="image/jpeg,image/png,image/webp" onChange={(event: ChangeEvent<HTMLInputElement>) => setPhoto(kind, event.target.files?.[0])} />
          </div>)}
        </div>
        <div className="step-title preserve-title"><span>02</span><div><h2>What should stay the same?</h2><p>We’ll make every other visual choice in the direction of your reference.</p></div></div>
        <div className="choices">{options.map((option) => <button key={option.key} className={`choice ${preserve[option.key] ? 'selected' : ''}`} onClick={() => setPreserve((current) => ({ ...current, [option.key]: !current[option.key] }))} aria-pressed={preserve[option.key]}><span className="check">{preserve[option.key] ? '✓' : ''}</span><span><strong>{option.label}</strong><small>{option.detail}</small></span></button>)}</div>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="generate" onClick={createEdit} disabled={busy}><span>{busy ? (status === 'analyzing' ? 'Reading your reference…' : 'Creating your edit…') : 'Create my edit'}</span><b>→</b></button>
        {prompt && <div className="prompt-card"><span>AI ART DIRECTION</span><p>{prompt}</p></div>}
        {result && (
          <section className="result">
            <div className="result-head">
              <div><p className="eyebrow">YOUR REFRAMED PHOTO</p><h2>Made for your point of view.</h2></div>
              <button className="download-btn" onClick={() => handleDownload(result)} disabled={downloading}>
                {downloading ? 'Saving…' : 'Download ↗'}
              </button>
            </div>
            <img src={result} alt="Generated reference-led edit" />
          </section>
        )}
      </section>
      <footer>PRIVATE BY DESIGN <span>·</span> IMAGES ARE NOT STORED</footer>
    </main>
  );
}

// Client-Side Image Resizer
async function prepareImageForUpload(file: File, maxDimension = 2000): Promise<File> {
  return new Promise((resolve) => {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      if (img.width <= maxDimension && img.height <= maxDimension) return resolve(file);

      let width = img.width;
      let height = img.height;
      if (width > height) {
        height = Math.round((height * maxDimension) / width);
        width = maxDimension;
      } else {
        width = Math.round((width * maxDimension) / height);
        height = maxDimension;
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => resolve(blob ? new File([blob], file.name, { type: 'image/jpeg' }) : file),
        'image/jpeg',
        0.92
      );
    };
    img.onerror = () => resolve(file);
  });
}