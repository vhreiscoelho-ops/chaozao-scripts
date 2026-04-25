const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const { load, save } = require('../store');

const router = express.Router();
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 120_000,
});

// ─── System context (cacheado pela API do Claude) ─────────────────────────────
const SYSTEM = `Você é um especialista sênior em vendas consultivas do Chãozão, maior plataforma de imóveis rurais do Brasil.
Você conhece profundamente o perfil do comprador rural brasileiro: proprietários de fazenda, produtores, investidores e corretores de interior.
Sua missão: gerar scripts que soem como uma conversa real entre um vendedor experiente e um amigo — nunca um roteiro de call center.

PRINCÍPIOS INEGOCIÁVEIS:
1. HUMANIDADE ACIMA DE TUDO — Cada fala deve soar como algo que um vendedor experiente diria naturalmente ao telefone, não como texto escrito.
2. FOCO NO FECHAMENTO — Cada etapa deve avançar em direção a uma decisão: assinar agora ou agendar data específica + proposta.
3. ZERO CORPORATIVISMO — Proibido: "excelente escolha", "com certeza", "claro que sim", "sem dúvida", "absolutamente", "perfeito", "fantástico". Proibido frases de chatbot.
4. LINGUAGEM REGIONAL — Use expressões do interior brasileiro quando pertinente ao perfil do lead. Seja direto e respeitoso como o homem do campo.
5. SEMPRE JSON PURO — Responda SEMPRE com JSON puro e válido. Nunca use markdown. Nunca adicione texto antes ou depois do JSON.`;

// ─── Estratégias para A/B ─────────────────────────────────────────────────────
const STRATEGIES = {
  urgencia: `ESTRATÉGIA: Urgência e Escassez.
Aplique ao longo de TODO o script, não só no fechamento.
- Na etapa 2: mencione casualmente que a condição/preço é por tempo limitado
- Na penúltima etapa: torne a urgência concreta (prazo real, não inventado)
- No fechamento: use a urgência como alavanca natural, não como pressão
- Tom: "olha, eu quero te avisar antes que mude" — não "é só até hoje!"`,

  sonho: `ESTRATÉGIA: Sonho e Identidade.
- Nas etapas de descoberta: faça o lead FALAR sobre o que quer (não você descrever)
- Use as próprias palavras do lead para espelhar o sonho de volta
- Conecte cada benefício do plano à realidade específica que ele descreveu
- No fechamento: "a gente já sabe o que você quer — isso aqui é o caminho"
- Linguagem: aspiracional mas concreta, não poética`,

  racional: `ESTRATÉGIA: Racional e ROI.
- Prepare 2-3 números concretos baseados no briefing (valorização, custo por lead, comparação)
- Cada afirmação de valor deve ter dado ou lógica por trás — não promessa vaga
- Antecipe objeções de preço com comparação custo vs. não anunciar
- No fechamento: mostre o cálculo — quanto custa não fechar agora vs. fechar
- Tom: analítico, mas não frio — "faz sentido no papel e na prática"`,

  consultivo: `ESTRATÉGIA: Consultivo.
- Etapa 1-2: APENAS perguntas — deixe o lead falar pelo menos 60% do tempo
- Use a técnica do diagnóstico: "antes de te apresentar qualquer coisa, me conta..."
- Só apresente solução depois de entender a dor real — não antes
- No fechamento: "baseado no que você me contou, isso resolve exatamente o problema X"
- Posição: parceiro que entende, não vendedor que empurra`,

  social: `ESTRATÉGIA: Prova Social.
- Use cases ESPECÍFICOS (mesmo que genéricos): "tive um cliente semana passada em MG..."
- Perfil similar ao lead — não use case de outro segmento
- Volume quando pertinente: "a maioria dos corretores da região já usa"
- No fechamento: "outros no seu perfil que foram em frente — como foi pra eles"
- Tom: "não precisa acreditar em mim — veja o que aconteceu com quem foi em frente"`
};

// ─── Extração robusta de JSON ─────────────────────────────────────────────────
function extractJson(text) {
  const t = text.trim();
  try { return JSON.parse(t); } catch {}
  const cb = t.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (cb) { try { return JSON.parse(cb[1].trim()); } catch {} }
  const bounds = t.match(/\{[\s\S]+\}/);
  if (bounds) { try { return JSON.parse(bounds[0]); } catch {} }
  console.error('[extractJson] falha ao parsear. Primeiros 500 chars:', t.slice(0, 500));
  throw new Error('JSON não encontrado na resposta da IA');
}

// ─── Bloco de score (comum a todos os prompts) ────────────────────────────────
const SCORE_SCHEMA = `
  "score": {
    "valor": number (1-10),
    "classificacao": "Alta propensão | Média propensão | Baixa propensão",
    "justificativa": "string (2 frases diretas baseadas no briefing)",
    "alertas": ["string (alerta prático para o closer, máx 3)"]
  },`;

const SCORE_REGRA = `- score: avalie 1-10 (8-10=alta, 5-7=média, 1-4=baixa) com base em urgência, fit, sinais de compra, perfil do decisor e objeções já mapeadas
- score.alertas: máximo 3, cada um com ação concreta para o closer`;

// ─── Prompts ──────────────────────────────────────────────────────────────────
function scriptPrompt(closer, callTime, planVal, briefing, strategy = null) {
  const stratBlock = strategy && STRATEGIES[strategy]
    ? `\n${STRATEGIES[strategy]}\nTodo o script deve seguir esta abordagem de forma consistente.\n`
    : '';

  return `Analise o briefing e retorne SOMENTE o objeto JSON abaixo. Comece com { e termine com }.
${stratBlock}
DADOS:
- Closer: ${closer}
- Horário da call: ${callTime || 'A definir'}
- Plano discutido: ${planVal}

BRIEFING DO SDR:
${briefing}

JSON esperado:
{${SCORE_SCHEMA}
  "lead_nome": "string",
  "subtitulo": "string (imóvel · cidade · horário · Closer: nome)",
  "alertas_topo": [{ "tipo": "verde|aviso|alerta", "titulo": "string", "texto": "string" }],
  "stats": [{ "label": "string", "val": "string", "sub": "string" }],
  "etapas": [{
    "titulo": "string", "tempo": "string (~X min)",
    "alerta": { "tipo": "verde|aviso|alerta", "texto": "string" },
    "falas": ["string"],
    "destaque": { "titulo": "string", "texto": "string" },
    "dica": "string", "chips": ["string"]
  }],
  "objecoes": [{ "titulo": "string (Se disser: …)", "resposta": "string" }],
  "fechamento": { "titulo": "string", "tempo": "~2 min", "falas": ["string"], "dica": "string" }
}

REGRAS DE CONTEÚDO:
${SCORE_REGRA}
- stats: exatamente 4 cards (Lead, Imóvel, Contexto da venda, Plano)
- etapas: entre 5 e 7 (excluindo objeções e fechamento)
- objecoes: 3 a 5, baseadas no perfil real do lead
- alertas_topo: máximo 2
- personalizar COMPLETAMENTE para o perfil do lead — nada de texto genérico

REGRAS DE LINGUAGEM — CRÍTICAS:
- Falas em PRIMEIRA PESSOA de ${closer}, como se fosse dito ao telefone agora
- PROIBIDO usar: "excelente", "fantástico", "perfeito", "com certeza", "sem dúvida", "absolutamente", "claro que sim", "ótima pergunta", "entendo sua preocupação"
- PROIBIDO frases de call center: "como posso te ajudar hoje?", "estou à disposição", "qualquer dúvida estou aqui"
- USE linguagem natural do interior brasileiro quando o perfil do lead pedir: "olha", "cara", "vou te ser direto", "deixa eu te contar uma coisa", "na prática", "no dia a dia"
- Cada fala deve ter UMA ideia só — frases curtas, no máximo 2 linhas
- Cada etapa DEVE avançar em direção ao fechamento ou proposta

REGRAS DE ESTRUTURA DAS ETAPAS:
- Etapa 1: quebra-gelo RÁPIDO (máx 30s) + âncora no motivo da call — sem papo prolongado
- Etapas do meio: descoberta consultiva ou apresentação de valor, sempre com pergunta que avança
- Penúltima etapa: criar condição para decisão (não "vou pensar" — oferecer alternativas concretas)
- Última etapa antes do fechamento: confirmação do fit — lead confirma que faz sentido
- Etapa FECHAMENTO: direto, sem rodeios, com 2 opções (fecha agora OU agenda data + gera proposta)

REGRA DE OURO DO FECHAMENTO:
O fechamento NUNCA deve ser "se você quiser, posso enviar mais informações".
Deve ser: "Então vamos fechar hoje? Se não der hoje, me diz uma data e eu mando a proposta com tudo que a gente conversou — você olha e me dá o sim."
Adapte essa lógica para o tom e plano do lead.`;
}

// ─── Catálogo de benefícios por plano ────────────────────────────────────────
const PLAN_CATALOG = `
PLANO ÚNICO VITALÍCIO (À vista R$ 1.198,00 | ou 3× R$ 399,33):
  - 1 anúncio ativo permanente na maior plataforma de imóveis rurais do Brasil
  - Acesso vitalício sem mensalidades — paga uma vez, anuncia para sempre
  - Sem renovação automática nem surpresas no bolso
  - Fotos ilimitadas por anúncio e descrição completa do imóvel
  - Aparece nas buscas orgânicas e no mapa interativo do Chãozão
  - Ideal para: proprietário com 1 imóvel que quer vender ou alugar sem pressa

PLANO 5 ANÚNCIOS (Anual R$ 184,80/mês | Semestral R$ 217,20/mês):
  - Até 5 anúncios ativos simultaneamente
  - Destaque nas buscas regionais — aparece antes dos anúncios gratuitos
  - Painel de analytics com visualizações e contatos por anúncio
  - Suporte prioritário por WhatsApp
  - Ideal para: corretor independente ou proprietário com pequeno portfólio

PLANO 10 ANÚNCIOS (Anual R$ 223,20/mês | Semestral R$ 260,40/mês):
  - Até 10 anúncios ativos simultaneamente
  - Destaque premium nas buscas + selo "Verificado" em todos os anúncios
  - Analytics avançado com comparativo de mercado regional
  - Leads qualificados encaminhados diretamente ao closer
  - Suporte prioritário com gerente de conta
  - Ideal para: imobiliária rural de pequeno/médio porte

PLANO 20 ANÚNCIOS (Anual R$ 358,80/mês | Semestral R$ 420,00/mês):
  - Até 20 anúncios ativos simultaneamente
  - Destaque máximo nas buscas + página de perfil da empresa no Chãozão
  - Analytics completo com relatórios exportáveis e histórico de leads
  - Integração com CRM via webhook
  - Gerente de conta dedicado
  - Ideal para: imobiliária ou produtor rural com portfólio ativo

PLANO 30 ANÚNCIOS (Anual R$ 450,00/mês | Semestral R$ 526,80/mês):
  - Até 30 anúncios ativos simultaneamente
  - Máxima visibilidade — topo garantido nos resultados de busca
  - Perfil verificado e destacado como Parceiro Premium Chãozão
  - Relatórios personalizados + integração CRM com suporte técnico
  - Gerente de conta dedicado + suporte prioritário 7 dias por semana
  - Ideal para: grandes imobiliárias rurais e fazendeiros com múltiplos imóveis`;

function proposalPrompt(closer, planVal, briefing) {
  // briefing aqui é construído pelo front: "Lead: X | Plano: Y | Valor: Z | Prazo: W | Desconto: ..."
  return `Gere uma proposta comercial compacta para ser enviada via WhatsApp. Retorne SOMENTE o JSON abaixo. Comece com { e termine com }. Sem markdown, sem texto fora do JSON.

DADOS:
- Closer: ${closer}
- ${briefing}

CATÁLOGO DE BENEFÍCIOS POR PLANO:
${PLAN_CATALOG}

JSON esperado:
{
  "lead_nome": "string (primeiro nome do lead)",
  "mensagem": "string (mensagem WhatsApp COMPLETA, pronta para copiar e enviar)"
}

REGRAS DA MENSAGEM:
- PROIBIDO usar travessão (—) em qualquer parte do texto. Use hífen simples (-) se precisar separar algo.
- Comece com: Olá, [primeiro nome]! 👋
- 1 linha curta e direta apresentando a proposta
- Bloco de investimento (escolha conforme os dados):
    * SEM desconto: *[nome do plano] - [valor]*
    * COM desconto: linha 1: ~[valor integral]~ *[valor negociado]* | linha 2: 💰 Você economiza [valor da economia]
- Liste de 3 a 4 benefícios principais do plano (catálogo acima, apenas os do plano informado), em tópicos com •
- Antes do final: ⏰ *Proposta válida até [data limite informada]*
- Penúltima linha: CTA simples e direto (ex: "É só me confirmar aqui que envio o link de pagamento! 🤝")
- Última linha OBRIGATÓRIA: 🌐 https://chaozao.com.br/
- Tom: caloroso, direto, sem exageros corporativos
- Sem "prezado", sem assinatura, sem saudações formais
- Máximo 16 linhas no total
- Use \\n para quebras de linha dentro da string JSON`;
}

// ─── Chamada à API (streaming p/ evitar timeout e reduzir latência percebida) ──
async function callClaude(prompt) {
  const stream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 5000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }]
  });
  const message = await stream.finalMessage();
  const raw = (message.content || []).map(c => c.text || '').join('');
  return extractJson(raw);
}

// ─── Salvar no histórico ───────────────────────────────────────────────────────
function saveItem(store, fields) {
  const id = store._seq.history++;
  store.history.unshift({
    id,
    resultado: null,
    observacao: '',
    ...fields,
    createdAt: new Date().toISOString()
  });
  return id;
}

// ─── Route ────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    mode      = 'script',
    closer    = 'Closer',
    callTime  = '',
    planVal   = '',
    briefing  = '',
    strategyA = 'urgencia',
    strategyB = 'sonho',
    linkedId  = null    // ID do script ao qual a proposta deve ser vinculada
  } = req.body;

  if (!briefing.trim())
    return res.status(400).json({ error: 'Briefing é obrigatório.' });
  if (briefing.length > 4000)
    return res.status(400).json({ error: 'Briefing muito longo (máx 4000 caracteres).' });

  try {
    // ── Modo A/B: duas variantes em paralelo ──────────────────────────────────
    if (mode === 'ab') {
      const [jsonA, jsonB] = await Promise.all([
        callClaude(scriptPrompt(closer, callTime, planVal, briefing, strategyA)),
        callClaude(scriptPrompt(closer, callTime, planVal, briefing, strategyB))
      ]);

      const abSessionId = Date.now().toString(36);
      const store = load();

      const base = { mode: 'script', closer, callTime, planVal, briefing: briefing.substring(0, 600), leadNome: jsonA.lead_nome || 'Lead', abSessionId };
      const idA = saveItem(store, { ...base, abGroup: 'A', strategy: strategyA, scoreValor: jsonA.score?.valor ?? null, leadNome: jsonA.lead_nome || 'Lead', resultJson: jsonA });
      const idB = saveItem(store, { ...base, abGroup: 'B', strategy: strategyB, scoreValor: jsonB.score?.valor ?? null, leadNome: jsonB.lead_nome || 'Lead', resultJson: jsonB });

      if (store.history.length > 200) store.history.length = 200;
      save(store);

      return res.json({
        ab: true,
        abSessionId,
        a: { id: idA, result: jsonA, strategy: strategyA },
        b: { id: idB, result: jsonB, strategy: strategyB }
      });
    }

    // ── Modo normal: script ou proposta ───────────────────────────────────────
    const prompt = mode === 'proposal'
      ? proposalPrompt(closer, planVal, briefing)
      : scriptPrompt(closer, callTime, planVal, briefing);

    const json = await callClaude(prompt);

    const store = load();

    // ── Proposta vinculada a um script existente ──────────────────────────────
    if (mode === 'proposal' && linkedId != null) {
      const target = store.history.find(h => h.id === Number(linkedId));
      if (target) {
        target.proposalMsg      = json.mensagem || '';
        target.proposalLeadNome = json.lead_nome || target.leadNome || '';
        target.updatedAt        = new Date().toISOString();
        save(store);
        return res.json({ id: target.id, linked: true, result: json });
      }
    }

    // ── Salva item normal ────────────────────────────────────────────────────
    const id = saveItem(store, {
      mode, closer, callTime, planVal,
      briefing: briefing.substring(0, 600),
      leadNome: json.lead_nome || 'Lead',
      scoreValor: json.score?.valor ?? null,
      resultJson: json,
      ...(mode === 'proposal' ? { proposalMsg: json.mensagem || '' } : {})
    });
    if (store.history.length > 200) store.history.length = 200;
    save(store);

    res.json({ id, result: json });

  } catch (err) {
    console.error('[generate] status:', err.status, '| type:', err.constructor?.name, '| msg:', err.message);
    const msg = err.status === 401 ? 'API Key inválida. Verifique o arquivo .env.'
      : err.status === 429 ? 'Limite de requisições atingido. Aguarde alguns segundos.'
      : err.message;
    res.status(500).json({ error: msg });
  }
});

module.exports = router;
