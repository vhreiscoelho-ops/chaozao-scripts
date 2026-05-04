const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const OpenAI     = require('openai');

const router = express.Router();

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000 });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 90_000 });

const SYSTEM = `Você é um especialista em design de campanhas e copywriting para o mercado rural brasileiro.
Trabalha para o Chãozão — maior plataforma de imóveis rurais do Brasil (2,5 M acessos/mês, 125 K seguidores).
REGRA ABSOLUTA: Responda SEMPRE com JSON puro e válido. Nunca use markdown. Sua resposta DEVE começar com { e terminar com }.`;

function extractJson(text) {
  const t = text.trim();
  try { return JSON.parse(t); } catch {}
  const cb = t.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (cb) { try { return JSON.parse(cb[1].trim()); } catch {} }
  const bounds = t.match(/\{[\s\S]+\}/);
  if (bounds) { try { return JSON.parse(bounds[0]); } catch {} }
  throw new Error('JSON inválido na resposta da IA');
}

// ── Gera o banner background com DALL-E 3 ────────────────────
async function gerarImagemFundo(campData) {
  const prompt = [
    'Professional Brazilian rural real estate marketing banner background, photorealistic.',
    'Scene: vast green farmland with wooden fence gate at golden hour sunset.',
    'Warm dramatic golden orange light on the horizon, dark dramatic sky with purple and orange clouds.',
    'Lush tropical vegetation on the left edge.',
    'Cinematic depth of field, high contrast, vibrant colors.',
    'Strong dark vignette on all edges and especially top and bottom for text overlay legibility.',
    'Semi-transparent dark overlay over the entire scene.',
    'No text, no logos, no watermarks. Pure photographic background.',
    'Aspect ratio 9:16 vertical portrait. Hyper-realistic DSLR photography style.',
  ].join(' ');

  const response = await openai.images.generate({
    model:   'dall-e-3',
    prompt,
    n:       1,
    size:    '1024x1792',
    quality: 'hd',
    style:   'vivid',
  });

  return response.data[0].url;
}

router.post('/', async (req, res) => {
  const { texto, valor, tipo = 'oferta' } = req.body;
  if (!texto || !valor) return res.status(400).json({ error: 'Campos obrigatórios: texto, valor.' });

  const prompt = `Crie uma campanha completa para o Chãozão com base nas informações abaixo.

INFORMAÇÕES DA CAMPANHA:
- Descrição / contexto: ${texto}
- Valor / oferta: ${valor}
- Tipo de campanha: ${tipo}

Retorne SOMENTE este JSON, começando com { e terminando com }:

{
  "titulo_l1": "string — primeira linha do título (branca), 1 a 3 palavras, MAIÚSCULAS",
  "titulo_l2": "string — segunda linha (DOURADA, destaque principal), 2 a 4 palavras, MAIÚSCULAS",
  "titulo_l3": "string — terceira linha (branca, com ! no final), 2 a 4 palavras, MAIÚSCULAS",
  "subtitulo_branco": "string — parte inicial do subtítulo (branca), máx 6 palavras",
  "subtitulo_ouro": "string — parte final do subtítulo (dourada), máx 6 palavras",
  "badge_esq": "string — rótulo badge superior esquerdo, máx 5 palavras, MAIÚSCULAS",
  "badge_dir": "string — texto badge circular direito, 2 linhas separadas por \\n, MAIÚSCULAS",
  "plano_nome": "string — nome do plano em 2 linhas separadas por \\n, MAIÚSCULAS",
  "plano_numero": "string — número ou destaque do plano (ex: '5', '30%', 'PRO')",
  "preco_de": "string — preço original com tachado (deixe vazio se não houver)",
  "preco_por": "string — preço final destacado (ex: R$ 129,50/mês)",
  "features": ["string MAIÚSCULAS 2 linhas com \\n", "string MAIÚSCULAS 2 linhas com \\n"],
  "cta_texto": "string — texto do botão CTA, MAIÚSCULAS, imperativo, máx 5 palavras",
  "whatsapp_copy": "string — mensagem completa para WhatsApp, 150-280 palavras, emojis, \\n\\n entre parágrafos",
  "hashtags": ["#chaozao", "#imovelrural", "#vendamais"]
}

REGRAS: titulo_l2 é o destaque central. preco_de e preco_por refletem o valor informado. PROIBIDO travessão (—).
ATENÇÃO FINAL: sua resposta DEVE começar com { e terminar com }. Nenhum texto fora do JSON.`;

  try {
    // Roda Claude e DALL-E em paralelo
    const [msg, imageUrl] = await Promise.all([
      claude.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 1800,
        system:     [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages:   [{ role: 'user', content: prompt }],
      }),
      gerarImagemFundo(),
    ]);

    const raw  = (msg.content || []).map(c => c.text || '').join('');
    const json = extractJson(raw);
    json.banner_bg_url = imageUrl; // URL temporária do DALL-E (válida por ~1 hora)
    res.json(json);
  } catch (err) {
    console.error('[campaign]', err.status, err.message);
    const msg = err.status === 401 ? 'API Key inválida.' :
                err.status === 429 ? 'Limite de requisições. Aguarde.' : err.message;
    res.status(500).json({ error: msg });
  }
});

module.exports = router;
