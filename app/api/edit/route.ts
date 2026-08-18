import { NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const featureKeys = ['pose', 'background', 'lighting', 'outfit'] as const;
type FeatureKey = (typeof featureKeys)[number];

// Upstash Redis Rate Limiter: Fixed 10 requests per IP address
const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.fixedWindow(6, '30 d'),
  analytics: false,
  prefix: '@upstash/ratelimit/testing',
});

function error(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function asDataUrl(file: File, bytes: Buffer) {
  return `data:${file.type};base64,${bytes.toString('base64')}`;
}

async function describeReference(reference: File, selectedToCopy: Record<FeatureKey, boolean>) {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error('Missing FAL_KEY on the server environment variables.');

  const referenceBytes = Buffer.from(await reference.arrayBuffer());
  
  const featuresToCopy = featureKeys.filter((item) => selectedToCopy[item]);
  const featuresToIgnore = featureKeys.filter((item) => !selectedToCopy[item]);

  const copyInstruction = featuresToCopy.length > 0
    ? featuresToCopy.join(', ')
    : 'overall aesthetic, composition, and visual style';

  const ignoreInstructions = featuresToIgnore.map((feature) => {
    switch (feature) {
      case 'pose':
        return 'DO NOT describe reference pose. State: "keeping original natural pose of [uploaded image]".';
      case 'background':
        return 'DO NOT describe reference background/environment/layout elements. State: "in a clean neutral setting".';
      case 'lighting':
        return 'DO NOT describe reference lighting effects or glow. State: "with balanced natural lighting".';
      case 'outfit':
        return 'DO NOT describe clothing or jewelry. State: "wearing [uploaded image]\'s original clothing".';
      default:
        return '';
    }
  }).filter(Boolean).join('\n');

  const response = await fetch('https://fal.run/openrouter/router/vision', {
    method: 'POST',
    headers: {
      Authorization: `Key ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      image_urls: [asDataUrl(reference, referenceBytes)],
      model: 'google/gemini-2.5-flash',
      temperature: 0.3,
      max_tokens: 300,
      system_prompt: 'You are an expert AI prompt engineer and visual style analyst. Output strictly a single detailed image generation prompt or CONTENT_POLICY_VIOLATION. No introduction, conversational text, or markdown formatting.',
      prompt: `CONTENT ASSESSMENT & STYLE-ADAPTIVE PROMPT GENERATION:

1. SAFETY CHECK:
Output "CONTENT_POLICY_VIOLATION" ONLY if the image contains explicit pornography, sexually explicit content, or undergarments/swimwear.
Note: Standard portraiture, exposed arms/shoulders, traditional garments (e.g., kurtas, sarees), art styles, and skin-tone clothing are FULLY SAFE and MUST NOT trigger a policy violation.

2. STYLE IDENTIFICATION & PROMPT GENERATION (If Safe):
Analyze the visual medium of the input image (e.g., Photographic, Anime/Manga, Oil Painting, 3D Render, Vintage Poster, Comic Book, Graphic Vector, Cyberpunk, Cinematic Still) and build a prompt using this structure:

- Core Medium & Style: Identify the exact style/medium (e.g., "Makoto Shinkai anime illustration", "1970s retro film poster", "Impressionist oil painting with impasto brushstrokes", "Cinematic portrait photograph").
- Layout & Composition: Detail layout, framing, multi-panel scrapbooks, torn paper edges, stickers, or shot angles.
- Subject & Pose: Describe the character/subject, pose, action, and facial expression.
- Lighting & Atmosphere: Detail light sources, color tones, backlighting, shadows, and mood (e.g., warm golden hour, vibrant neon glow, muted pastels).
- Textures & Overlays: Specify paper textures, film grain, graphic widgets, handwriting script, or digital painterly effects.
- Fine Details: Capture micro-details like apparel textures, accessories, jewelry, background depth, or specialized brushwork.

SELECTED FEATURES TO COPY: ${copyInstruction}.
EXCLUSION RULES: ${ignoreInstructions.length > 0 ? ignoreInstructions : 'Extract all key visual details freely.'}

STRICT CONSTRAINTS:
- Never use terms like "sensual", "intimate", "erotic", or "bare skin". Use neutral terms like "warm aesthetic" or "cultural attire".
- Do not use real brand or trademark names; describe visual elements generically.
- Keep the subject description generic without inferring specific personal identities.`
    })
  });

  const responseText = await response.text();
  let body: any;
  try {
    body = JSON.parse(responseText);
  } catch {
    throw new Error(`Vision API error (${response.status}): ${responseText.slice(0, 100)}`);
  }

  if (!response.ok) throw new Error(body?.error?.message || body?.detail || 'Reference analysis failed.');
  
  const prompt = body?.output || body?.choices?.[0]?.message?.content;
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('The analysis model returned no instruction.');
  
  const cleanPrompt = prompt.trim();

  if (cleanPrompt.includes('CONTENT_POLICY_VIOLATION')) {
    throw new Error('Image contains restricted content (e.g., swimwear or explicit clothing). Please select a different image.');
  }

  return cleanPrompt;
}

async function createImageEdit(original: File, prompt: string, quality: 'low' | 'medium' | 'high' = 'low') {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error('Missing FAL_KEY on the server environment variables.');

  const originalBytes = Buffer.from(await original.arrayBuffer());
  const finalPrompt = prompt.replace(/\[uploaded image\]/gi, "the subject in the image");

  const response = await fetch('https://fal.run/openai/gpt-image-2/edit', {
    method: 'POST',
    headers: { 
      Authorization: `Key ${key}`, 
      'Content-Type': 'application/json' 
    },
    body: JSON.stringify({
      prompt: `${finalPrompt}\n\nKeep all other unmentioned details and subject facial identity intact.`,
      image_urls: [asDataUrl(original, originalBytes)],
      quality: quality,
      input_fidelity: 'low',
      aspect_ratio: '1:1'
    })
  });

  const responseText = await response.text();
  let body: any;
  try {
    body = JSON.parse(responseText);
  } catch {
    throw new Error(`Generation API error (${response.status}): ${responseText.slice(0, 100)}`);
  }

  if (!response.ok) throw new Error(body?.error?.message || body?.detail || 'Image generation failed.');

  const image = body?.images?.[0]?.url;
  if (typeof image !== 'string') throw new Error('The image model returned no output URL.');

  return image;
}

export async function POST(request: Request) {
  try {
    // 1. Robust IP Detection for Desktop + Mobile Carriers (Cloudflare, Vercel proxies)
    const ip = 
      request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
      request.headers.get('x-real-ip') ||
      request.headers.get('cf-connecting-ip') ||
      '127.0.0.1';

    const { success, remaining } = await ratelimit.limit(ip);

    if (!success) {
      return NextResponse.json(
        { error: 'Testing limit reached: You have used all 10 free test generations allowed for your IP address.' },
        { status: 429 }
      );
    }

    // 2. Parse Form Data
    const form = await request.formData();
    const original = form.get('original');
    const reference = form.get('reference');
    const selection = form.get('preserve');
    const qualityInput = (form.get('quality') as string) || 'low';

    if (!(original instanceof File) || !(reference instanceof File) || typeof selection !== 'string') {
      return error('Both images and your feature copy choices are required.');
    }

    for (const image of [original, reference]) {
      if (!allowedTypes.has(image.type) || image.size === 0 || image.size > MAX_FILE_SIZE) {
        return error('Use a JPG, PNG, or WEBP image up to 10 MB.');
      }
    }

    let selectedToCopy: Record<FeatureKey, boolean>;
    try { 
      selectedToCopy = JSON.parse(selection); 
    } catch { 
      return error('Invalid copy selections.'); 
    }

    const quality = ['low', 'medium', 'high'].includes(qualityInput) 
      ? (qualityInput as 'low' | 'medium' | 'high') 
      : 'low';

    // 3. Vision Analysis
    const prompt = await describeReference(reference, selectedToCopy);

    // 4. Image Edit Generation
    const image = await createImageEdit(original, prompt, quality);

    return NextResponse.json(
      { 
        prompt, 
        image, 
        remainingTests: remaining 
      }, 
      { headers: { 'Cache-Control': 'no-store' } }
    );

  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Unable to create your edit.';
    console.error('Image edit failure:', message);
    return error(message, 500);
  }
}
