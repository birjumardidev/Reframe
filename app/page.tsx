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

  async function createEdit() {
    if (!files.original || !files.reference) { setError('Add both your original and reference image first.'); return; }
    if (!Object.values(preserve).some(Boolean)) { setError('Choose at least one detail to preserve.'); return; }
    setError(''); setResult(null); setStatus('analyzing');
    const data = new FormData();
    data.append('original', files.original);
    data.append('reference', files.reference);
    data.append('preserve', JSON.stringify(preserve));
    try {
      const response = await fetch('/api/edit', { method: 'POST', body: data });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'We could not create this edit.');
      setPrompt(payload.prompt); setStatus('editing');
      // Briefly reveal the generated instruction before displaying the result.
      await new Promise((resolve) => setTimeout(resolve, 450));
      setResult(payload.image); setStatus('idle');
    } catch (requestError) {
      setStatus('error'); setError(requestError instanceof Error ? requestError.message : 'Something went wrong.');
    }
  }

  const busy = status === 'analyzing' || status === 'editing';
  return <main>
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
      {result && <section className="result"><div className="result-head"><div><p className="eyebrow">YOUR REFRAMED PHOTO</p><h2>Made for your point of view.</h2></div><a href={result} download="reframe-edit.png">Download ↗</a></div><img src={result} alt="Generated reference-led edit" /></section>}
    </section>
    <footer>PRIVATE BY DESIGN <span>·</span> IMAGES ARE NOT STORED</footer>
  </main>;
}
