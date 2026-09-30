// S5 vision: premium-look rubric (spec 3.5) and white-label image check (3.1). Needs ANTHROPIC_API_KEY;
// without it every product is marked UNVERIFIED and goes to REVIEW for you to judge the photos.
import Anthropic from '@anthropic-ai/sdk';

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

const RUBRIC = `You judge product photos for Vourelle: timeless, quietly expensive-looking winter womenswear (old-money, heritage, country estate).
Score 1-5:
5 = looks like a $200+ brand piece: substantial fabric with visible texture, clean seams, structured drape, classic cut, neutral colour, calm styling.
4 = premium enough once photos are enhanced; minor issues only.
3 = mid-market; acceptable only as an add-on.
1-2 = fast-fashion look: shiny thin synthetic, cheap hardware, loud print, trendy cut.
List in "fails" any automatic fail you see: slogans or graphics, glitter or sequins, neon, cut-outs or overtly sexy styling, visible pilling or loose threads, collage images with Chinese text, heavily distorted models, recognisable designer copies (Burberry-style check, Kelly or Birkin bag shape, horsebit hardware, interlocking-C buttons).
logo_or_text = true if any image shows a visible brand label, neck-tag brand text, logo on the garment or hardware, watermark, store name or promotional text. Plain care and size labels are fine.
images_consistent = false if the images show different garments, colours or fabrics from each other.
on_model = true if at least one image shows the piece worn by a person.`;

const SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer' },
    fails: { type: 'array', items: { type: 'string' } },
    logo_or_text: { type: 'boolean' },
    images_consistent: { type: 'boolean' },
    on_model: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['score', 'fails', 'logo_or_text', 'images_consistent', 'on_model', 'notes'],
  additionalProperties: false,
};

// Returns the rubric JSON, or null when vision is off or fails (the product is then UNVERIFIED, never passed).
export async function judge(p, cfg) {
  if (!client) return null;
  try {
    const images = p.images.slice(0, cfg.quality.vision_images_checked)
      .map((url) => ({ type: 'image', source: { type: 'url', url: url.startsWith('//') ? `https:${url}` : url } }));
    const haiku = /haiku/.test(cfg.run.vision_model); // Haiku 4.5 takes neither effort nor server-side fallbacks
    const res = await client.beta.messages.create({
      model: cfg.run.vision_model,
      max_tokens: 2000,
      ...(haiku ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
      output_config: { ...(haiku ? {} : { effort: 'low' }), format: { type: 'json_schema', schema: SCHEMA } },
      system: RUBRIC,
      messages: [{ role: 'user', content: [...images, { type: 'text', text: `Product: ${p.title}` }] }],
    });
    if (res.stop_reason === 'refusal') return null;
    const text = res.content.find((b) => b.type === 'text')?.text;
    return text ? JSON.parse(text) : null;
  } catch (e) {
    console.warn(`vision failed for ${p.id}: ${e.message}`);
    return null;
  }
}
