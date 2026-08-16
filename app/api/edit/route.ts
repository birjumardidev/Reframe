import { NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const featureKeys = ['pose', 'background', 'lighting', 'outfit'] as const;
type FeatureKey = (typeof featureKeys)[number];

// Initialize Upstash Redis Rate Limiter: Capped at 10 requests per IP address
const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.fixedWindow(10, '30 d'),
  analytics: true,
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
  if (!key) throw new Error('Missing FAL_KEY on the server.');

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
      temperature: 0.1, // Lower temperature for strict safety evaluation
      max_tokens: 450,
      system_prompt: 'You are an elite AI art director and content safety reviewer. Output strictly a single image generation prompt or safety error code. No intro, analysis, or markdown.',
      prompt: `CRITICAL SAFETY PRE-SCREENING:
Analyze this image. If it contains ANY nudity, suggestive attire (such as bikinis, swimsuits, undergarments, or heavy exposure), or sexually implicit poses, STOP IMMEDIATELY. Output strictly the exact text: CONTENT_POLICY_VIOLATION.

If the image is fully safe and non-explicit, proceed to extract its visual style and layout for "[uploaded image]".

SELECTED FEATURES TO COPY: ${copyInstruction}.

UNSELECTED FEATURES RULES:
${ignoreInstructions.length > 0 ? ignoreInstructions : 'Extract all visual details freely.'}

SYSTEMATIC STRUCTURE TO FOLLOW:
1. Overall Style & Composition: Specify if it is a single shot, multi-panel collage, scrapbook, magazine cover, or UI breakdown. Describe frames, torn paper edges, paper clips, tape, white sticker borders, or grid arrangements.
2. Graphic, Light & UI Overlays: Detail any special visual effects like neon light-writing (e.g. glowing text in hands), glassmorphism UI cards, music player graphic widgets, 3D chibi character stickers, hand-drawn doodle arrows/hearts, or bold cover headlines.
3. Subject Framing & Pose: Detail the exact shot angle (e.g. close-up portrait, side profile, selfie pose resting head on hand) for [uploaded image].
4. Lighting & Color Atmosphere: Describe specific light sources (e.g. rim lighting, golden hour glow, neon backlight, low-key contrast, soft studio diffuse).
5. Styling, Optics & Fine Details: Capture micro-details such as skin texture, hair strands, jewelry (e.g. silver jhumkas), fabric patterns, shallow depth of field, creamy bokeh, and color grading.

STRICT SAFETY & CONTENT POLICY RULES (CRITICAL):
1. ZERO NSFW / SUGGESTIVE LANGUAGE: Never use words like "intimate", "sensual", "erotic", "cleavage", "bare skin", "revealing", or suggestive body descriptors. Use safe, professional terms like "warm lighting", "cinematic portrait", or "elegant aesthetic".
2. NO BRAND NAMES OR TRADEMARKS: Do not output brand names like "Spotify", "Netflix", "Instagram", or "Kodak". Describe them generically instead (e.g., "digital music player interface", "streaming platform poster", "vintage film grain").
3. Always refer to the target subject strictly as "[uploaded image]".
4. DO NOT describe facial identity or specific facial structure from this reference photo.`
    })
  });

  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || 'Reference analysis failed.');
  
  const prompt = body?.output || body?.choices?.[0]?.message?.content;
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('The analysis model returned no instruction.');
  
  const cleanPrompt = prompt.trim();

  // Intercept Safety Trigger
  if (cleanPrompt.includes('CONTENT_POLICY_VIOLATION')) {
    throw new Error('Image contains restricted content (e.g., swimwear or explicit clothing). Please select a different image.');
  }

  return cleanPrompt;
}

async function createImageEdit(original: File, prompt: string, quality: 'low' | 'medium' | 'high' = 'low') {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error('Missing FAL_KEY on the server.');

  const originalBytes = Buffer.from(await original.arrayBuffer());
  const finalPrompt = prompt.replace(/\[uploaded image\]/gi, "the subject in the image");

  // Endpoint updated to GPT-Image-2 edit
  const response = await fetch('https://fal.run/openai/gpt-image-2/edit', {
    method: 'POST',
    headers: { 
      Authorization: `Key ${key}`, 
      'Content-Type': 'application/json' 
    },
    body: JSON.stringify({
      prompt: `${finalPrompt}\n\nKeep all other unmentioned details and subject facial identity intact.`,
      image_urls: [asDataUrl(original, originalBytes)],
      quality: quality, // Evaluates to 'low' (~$0.015)
      input_fidelity: 'low' // Keeps input vision token processing cost low
    })
  });

  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || 'Image generation failed.');

  const image = body?.images?.[0]?.url;
  if (typeof image !== 'string') throw new Error('The image model returned no output URL.');

  return image;
}

export async function POST(request: Request) {
  try {
    // 1. IP Detection & Rate Limiting (10 Limits Max)
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || '127.0.0.1';
    const { success, remaining } = await ratelimit.limit(ip);

    if (!success) {
      return NextResponse.json(
        { error: 'Testing limit reached: You have used all 10 free test generations allowed for your IP address.' },
        { status: 429 }
      );
    }

    // 2. Parse Incoming Form Data
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

    // 3. Analyze Reference Image with Gemini Vision
    const prompt = await describeReference(reference, selectedToCopy);

    // 4. Generate Image Edit with GPT Image 2 Edit (Low Quality ~$0.0123)
    const image = await createImageEdit(original, prompt, quality);

    return NextResponse.json(
      { 
        prompt, 
        image, 
        remainingTests: remaining // Returns remaining test count (e.g., 9, 8, 7...)
      }, 
      { headers: { 'Cache-Control': 'no-store' } }
    );

  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Unable to create your edit.';
    console.error('Image edit failure:', message);
    return error(message, 500);
  }
}


