const express  = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI    = require('openai');

const router = express.Router();

function getClaude() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000 });
}
function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120_000 });
}

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

// ── Gera banner completo com gpt-image-1 ─────────────────────────────────────
async function gerarBannerCompleto(d) {
  const key = process.env.OPENAI_API_KEY;
  console.log('[DALLE] key:', key ? '✅ ' + key.slice(0,14) + '...' : '❌ AUSENTE');

  const l1 = d.titulo_l1 || '';
  const l2 = d.titulo_l2 || '';
  const l3 = d.titulo_l3 || '';
  const badgeEsq = (d.badge_esq || '').replace(/\\n/g, ' ');
  const badgeDir = (d.badge_dir || '').replace(/\\n/g, '\n');
  const subB = d.subtitulo_branco || '';
  const subO = d.subtitulo_ouro || '';
  const planoNome = (d.plano_nome || '').replace(/\\n/g, ' ');
  const planoNum = d.plano_numero || '';
  const precoDe = d.preco_de || '';
  const precoPor = d.preco_por || '';
  const feat1 = ((d.features || [])[0] || '').replace(/\\n/g, ' ');
  const feat2 = ((d.features || [])[1] || '').replace(/\\n/g, ' ');
  const cta = d.cta_texto || 'FALE CONOSCO AGORA';

  const imagePrompt = `Design a vertical social media marketing banner (9:16 ratio, like an Instagram Story) for a Brazilian rural real estate company called Chãozão.

VISUAL STYLE: Professional Brazilian digital marketing banner. Dark green and black background (#0a1a06). Golden hour rural landscape (farmland, wooden fence, sunset sky with orange clouds) softly blended into the background. Gold (#F5C518) and white as main text colors. Clean bold typography, heavy black-weight sans-serif. High contrast. Similar to premium Canva marketing templates.

EXACT LAYOUT from top to bottom:

① Thin horizontal gold line across the full top edge.

② Header row: On the left, a small horizontal pill-shaped badge with a lock icon, dark green background, gold border, white bold text reading "${badgeEsq}". On the far right, a circular badge with dark green background, gold circular border, gold bold text reading "${badgeDir}".

③ Three-line hero title, large bold heavy text, left-aligned:
   First line in white: "${l1}"
   Second line in bright gold (#F5C518), slightly larger and bolder: "${l2}"
   Third line in white: "${l3}"

④ Subtitle block with a vertical gold bar on the left: white text "${subB}" on one line, gold text "${subO}" on the next line.

⑤ Dark green rounded rectangle price box with gold border:
   Left side: small white label "${planoNome}", below it a huge gold number/text "${planoNum}".
   Vertical gold divider line in the middle.
   Right side: ${precoDe ? `small text "DE:" followed by "${precoDe}" with a red diagonal strikethrough line,` : ''} a small gold pill badge labeled "POR:", then large bold gold text "${precoPor}".

⑥ Two side-by-side feature cards with semi-transparent dark green background and gold borders:
   Left card: circular gold icon with 📄, bold white text "${feat1}".
   Right card: circular gold icon with ⚡, bold white text "${feat2}".

⑦ Full-width green gradient pill button (dark green to bright green, #196624 to #24a033) with a WhatsApp logo icon on the left and bold white uppercase italic text: "${cta}".

⑧ Thin gold separator line, then small centered white text: "chaozao.com.br  ·  Maior plataforma de imóveis rurais do Brasil".

IMPORTANT: All text must be perfectly legible, crisp, and exactly as specified. No extra decorations. No watermarks. High resolution.`;

  console.log('[DALLE] gerando banner...');
  const response = await getOpenAI().images.generate({
    model:   'gpt-image-1',
    prompt:  imagePrompt,
    n:       1,
    size:    '1024x1536',
    quality: 'high',
  });

  const imgData = response.data[0];
  if (imgData.b64_json) {
    console.log('[DALLE] banner gerado (base64)');
    return 'data:image/png;base64,' + imgData.b64_json;
  }
  console.log('[DALLE] banner gerado (url):', imgData.url?.slice(0,60) + '...');
  return imgData.url;
}

router.post('/', async (req, res) => {
  const { texto, valor, tipo = 'oferta' } = req.body;
  if (!texto || !valor) return res.status(400).json({ error: 'Campos obrigatórios: texto, valor.' });

  const prompt = `Crie uma campanha completa para o Chãozão com base nas informações abaixo.

INFORMAÇÕES DA CAMPANHA:
- Descrição / contexto: ${texto}
- Valor / oferta: ${valor}
- Tipo de campanha: ${tipo}

══════════════════════════════════════════
EXEMPLOS REAIS DE CAMPANHAS CHÃOZÃO (use como referência de tom, estilo e estrutura):

EXEMPLO 1 — Campanha de reativação para corretor (plano 5 anúncios, 30% off):
{
  "titulo_l1": "LIBERAMOS",
  "titulo_l2": "UMA CONDIÇÃO",
  "titulo_l3": "PRA SUA CONTA!",
  "subtitulo_branco": "Porque você já chegou",
  "subtitulo_ouro": "muito perto de fechar.",
  "badge_esq": "CONDIÇÃO EXCLUSIVA\\nDE REATIVAÇÃO",
  "badge_dir": "MAIS VISIBILIDADE\\nMAIS RESULTADOS",
  "plano_nome": "PLANO DE\\nANÚNCIOS",
  "plano_numero": "5",
  "preco_de": "R$ 184,00/mês",
  "preco_por": "R$ 129,50/mês",
  "features": ["PAGAMENTO NO BOLETO\\n(SEM CARTÃO)", "ATIVAÇÃO RÁPIDA\\nAPÓS PAGAMENTO"],
  "cta_texto": "RETOMAR MINHA CONDIÇÃO",
  "whatsapp_copy": "...",
  "hashtags": ["#chaozao", "#imovelrural", "#corretorrural"]
}

EXEMPLO 2 — Campanha para proprietário (plano único, pagamento boleto):
{
  "titulo_l1": "PLANO ÚNICO",
  "titulo_l2": "CHÃOZÃO",
  "titulo_l3": "ANUNCIE AGORA!",
  "subtitulo_branco": "O jeito mais fácil e seguro",
  "subtitulo_ouro": "de anunciar seu imóvel rural.",
  "badge_esq": "PARA PROPRIETÁRIOS",
  "badge_dir": "PAGAMENTO\\nVIA BOLETO",
  "plano_nome": "PLANO\\nPROPRIETÁRIO",
  "plano_numero": "3x",
  "preco_de": "R$ 1.199,00",
  "preco_por": "R$ 339,43/mês",
  "features": ["1 ANÚNCIO\\nATIVO ATÉ VENDER", "SIMPLES E SEGURO\\nSEM CARTÃO"],
  "cta_texto": "CONTRATAR AGORA",
  "whatsapp_copy": "...",
  "hashtags": ["#chaozao", "#imovelrural", "#vendamais"]
}
══════════════════════════════════════════

REGRAS DE COPY (siga à risca):
- titulo_l1: gancho de ação (1-3 palavras), MAIÚSCULAS, branco
- titulo_l2: destaque principal (2-4 palavras), MAIÚSCULAS, DOURADO — o mais impactante
- titulo_l3: fechamento com urgência ou benefício + "!" (2-4 palavras), MAIÚSCULAS, branco
- badge_esq: identifica o público ou condição (ex: PARA CORRETORES, OFERTA EXCLUSIVA)
- badge_dir: 2 linhas com o diferencial do pagamento ou benefício-chave
- plano_nome: nome do plano em 2 linhas (ex: PLANO DE\\nANÚNCIOS ou CORRETOR\\nPRO)
- plano_numero: o número mais impactante (ex: 5, 3x, 15%, PRO)
- features: 2 benefícios práticos em MAIÚSCULAS com 2 linhas cada (\\n entre elas)
- cta_texto: imperativo direto, máx 4 palavras (ex: CONTRATAR AGORA, GARANTIR DESCONTO)
- whatsapp_copy: 150-280 palavras, linguagem direta e rural, emojis, \\n\\n entre parágrafos
- PROIBIDO: travessão (—), frases genéricas, palavras fora do contexto rural/imobiliário

Retorne SOMENTE este JSON, começando com { e terminando com }:

{
  "titulo_l1": "...",
  "titulo_l2": "...",
  "titulo_l3": "...",
  "subtitulo_branco": "...",
  "subtitulo_ouro": "...",
  "badge_esq": "...",
  "badge_dir": "...",
  "plano_nome": "...",
  "plano_numero": "...",
  "preco_de": "...",
  "preco_por": "...",
  "features": ["...", "..."],
  "cta_texto": "...",
  "whatsapp_copy": "...",
  "hashtags": ["#chaozao", "#imovelrural", "..."]
}

REGRAS: titulo_l2 é o destaque central. preco_de e preco_por refletem o valor informado. PROIBIDO travessão (—).
ATENÇÃO FINAL: sua resposta DEVE começar com { e terminar com }. Nenhum texto fora do JSON.`;

  try {
    // 1. Claude gera o copy
    let claudeMsg;
    try {
      claudeMsg = await getClaude().messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 1800,
        system:     [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages:   [{ role: 'user', content: prompt }],
      });
    } catch (err) {
      console.error('[campaign] Claude falhou:', err.status, err.message);
      const s = err.status || 500;
      return res.status(500).json({ error: s === 401 ? 'ANTHROPIC_API_KEY inválida.' : s === 429 ? 'Limite Claude atingido.' : err.message });
    }

    const raw  = (claudeMsg.content || []).map(c => c.text || '').join('');
    const json = extractJson(raw);

    // 2. gpt-image-1 gera o banner completo
    try {
      json.banner_bg_url = await gerarBannerCompleto(json);
    } catch (dErr) {
      console.error('[campaign] DALLE falhou:', dErr.status, dErr.message);
      json.dall_e_error = `${dErr.status || ''} ${dErr.message || ''}`.trim();
    }

    res.json(json);
  } catch (err) {
    console.error('[campaign] erro geral:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
