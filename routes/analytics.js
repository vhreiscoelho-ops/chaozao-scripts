const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const { load }  = require('../store');

const router = express.Router();
const client = new Anthropic();

const RES_LABELS = {
  fechou: '✅ Fechou', proposta: '📄 Proposta env.',
  reagendou: '📅 Reagendou', sem_perfil: '❌ Sem perfil', perdeu: '🔴 Perdeu'
};

// ─── GET /api/analytics ───────────────────────────────────────────────────────
router.get('/', (_req, res) => {
  const { history } = load();
  if (!history.length) return res.json({ empty: true, total: 0 });

  const withResult  = history.filter(h => h.resultado);
  const total       = history.length;
  const totalResult = withResult.length;
  const fechouTotal = withResult.filter(h => h.resultado === 'fechou').length;
  const taxaGeral   = totalResult > 0 ? Math.round(fechouTotal / totalResult * 100) : 0;

  const comScore   = history.filter(h => h.scoreValor != null);
  const scoreMedio = comScore.length
    ? +(comScore.reduce((s, h) => s + h.scoreValor, 0) / comScore.length).toFixed(1)
    : null;

  // Por closer
  const closerMap = {};
  history.forEach(h => {
    if (!closerMap[h.closer]) closerMap[h.closer] = { total:0, comResultado:0, fechou:0, proposta:0, scoreSum:0, scoreCount:0 };
    const c = closerMap[h.closer];
    c.total++;
    if (h.scoreValor != null) { c.scoreSum += h.scoreValor; c.scoreCount++; }
    if (h.resultado) {
      c.comResultado++;
      if (h.resultado === 'fechou')   c.fechou++;
      if (h.resultado === 'proposta') c.proposta++;
    }
  });
  const byCloser = Object.entries(closerMap)
    .map(([name, c]) => ({
      name, total: c.total, comResultado: c.comResultado,
      fechou: c.fechou, proposta: c.proposta,
      taxa:       c.comResultado > 0 ? Math.round(c.fechou / c.comResultado * 100) : null,
      scoreMedio: c.scoreCount   > 0 ? +(c.scoreSum / c.scoreCount).toFixed(1)     : null
    }))
    .sort((a, b) => (b.taxa ?? -1) - (a.taxa ?? -1));

  // Distribuição
  const dist = Object.keys(RES_LABELS).map(key => ({
    key, label: RES_LABELS[key],
    count: withResult.filter(h => h.resultado === key).length
  })).filter(d => d.count > 0);

  // Score por resultado
  const scoreAcc = {};
  withResult.forEach(h => {
    if (h.scoreValor == null) return;
    if (!scoreAcc[h.resultado]) scoreAcc[h.resultado] = { sum:0, count:0 };
    scoreAcc[h.resultado].sum   += h.scoreValor;
    scoreAcc[h.resultado].count += 1;
  });
  const scoreByResult = Object.entries(scoreAcc)
    .map(([key, d]) => ({ key, label: RES_LABELS[key]||key, media: +(d.sum/d.count).toFixed(1), count: d.count }))
    .sort((a, b) => b.media - a.media);

  // Por horário
  const hourMap = {};
  history.filter(h => h.callTime && h.resultado).forEach(h => {
    const hora = h.callTime.substring(0,2)+'h';
    if (!hourMap[hora]) hourMap[hora] = { total:0, fechou:0 };
    hourMap[hora].total++;
    if (h.resultado === 'fechou') hourMap[hora].fechou++;
  });
  const byHour = Object.entries(hourMap)
    .map(([hora, d]) => ({ hora, total:d.total, fechou:d.fechou, taxa: Math.round(d.fechou/d.total*100) }))
    .sort((a, b) => b.taxa - a.taxa);

  // Tendência 30 dias
  const cutoff   = new Date(Date.now() - 30*864e5).toISOString();
  const recentes = withResult.filter(h => h.createdAt >= cutoff);
  const tendencia = {
    total:  recentes.length,
    fechou: recentes.filter(h => h.resultado === 'fechou').length,
    taxa:   recentes.length ? Math.round(recentes.filter(h=>h.resultado==='fechou').length / recentes.length * 100) : 0
  };

  // A/B performance
  const abItems   = history.filter(h => h.abGroup && h.resultado);
  const abByStrat = {};
  abItems.forEach(h => {
    const k = h.strategy || 'padrao';
    if (!abByStrat[k]) abByStrat[k] = { total:0, fechou:0 };
    abByStrat[k].total++;
    if (h.resultado === 'fechou') abByStrat[k].fechou++;
  });
  const abPerformance = Object.entries(abByStrat)
    .map(([strategy, d]) => ({ strategy, total:d.total, fechou:d.fechou, taxa: Math.round(d.fechou/d.total*100) }))
    .sort((a, b) => b.taxa - a.taxa);

  res.json({ empty:false, total, totalResult, fechouTotal, taxaGeral, scoreMedio, byCloser, dist, scoreByResult, byHour, tendencia, abPerformance });
});

// ─── POST /api/analytics/insights ────────────────────────────────────────────
router.post('/insights', async (_req, res) => {
  const { history } = load();

  const vencedores = history.filter(h => h.resultado === 'fechou'  && h.resultJson);
  const perdedores = history.filter(h => ['perdeu','sem_perfil'].includes(h.resultado) && h.resultJson);

  if (vencedores.length < 3)
    return res.status(400).json({ error: `Precisa de pelo menos 3 fechamentos para análise. Você tem ${vencedores.length}.` });

  // Resumo compacto para não explodir o contexto
  const summarize = item => ({
    lead_score:        item.scoreValor,
    closer:            item.closer,
    horario:           item.callTime,
    strategy:          item.strategy || 'padrao',
    etapas:            (item.resultJson?.etapas || []).map(e => e.titulo),
    falas_abertura:    item.resultJson?.etapas?.[0]?.falas?.[0] || '',
    fala_fechamento:   item.resultJson?.fechamento?.falas?.[0] || '',
    objecoes_mapeadas: (item.resultJson?.objecoes || []).map(o => o.titulo),
    alertas:           (item.resultJson?.alertas_topo || []).map(a => a.texto)
  });

  const winSample  = vencedores.slice(0, 10).map(summarize);
  const loseSample = perdedores.slice(0,  8).map(summarize);

  const prompt = `Você é um consultor de vendas sênior especializado em análise de performance comercial.

Analise os dados abaixo de ligações de venda do Chãozão (imóveis rurais) e identifique padrões concretos entre o que FECHOU e o que NÃO fechou.

SCRIPTS QUE FECHARAM (${winSample.length} casos):
${JSON.stringify(winSample, null, 2)}

SCRIPTS QUE NÃO FECHARAM (${loseSample.length} casos):
${JSON.stringify(loseSample, null, 2)}

Retorne APENAS este JSON:
{
  "resumo": "string (diagnóstico geral em 2-3 frases diretas e sem rodeios)",
  "padroes_vencedores": [
    { "titulo": "string", "descricao": "string (o que os fechamentos têm em comum)", "impacto": "alto|medio" }
  ],
  "padroes_perdedores": [
    { "titulo": "string", "descricao": "string (padrão comum nas perdas)" }
  ],
  "perfil_lead_ideal": "string (características do lead que mais fecha — score, contexto, perfil)",
  "recomendacoes": ["string (ação concreta e implementável pelo time)"],
  "proxima_hipotese": "string (próxima variável a testar no A/B para melhorar conversão)"
}

REGRAS:
- Seja brutalmente honesto — não suavize padrões negativos
- Foque em padrões ACIONÁVEIS, não em observações óbvias
- padroes_vencedores: 3 a 5 padrões com impacto alto ou médio
- padroes_perdedores: 2 a 3 padrões
- recomendacoes: 3 a 4 ações que o time pode aplicar amanhã
- Retorne APENAS o JSON`;

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }]
    });
    const raw  = (message.content || []).map(c => c.text || '').join('');
    const json = JSON.parse(raw.replace(/```json|```/g,'').trim());
    res.json(json);
  } catch(err) {
    console.error('[insights]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/analytics/coaching ────────────────────────────────────────────
router.post('/coaching', async (req, res) => {
  const { transcricao, scriptJson, resultado, closer } = req.body;

  if (!transcricao || transcricao.trim().length < 30)
    return res.status(400).json({ error: 'Transcrição muito curta. Grave a ligação completa antes de analisar.' });

  const etapas   = (scriptJson?.etapas   || []).map(e => e.titulo).join(', ');
  const objecoes = (scriptJson?.objecoes || []).map(o => o.titulo).join('; ');

  const prompt = `Você é um coach de vendas sênior especializado em imóveis rurais. Analise a transcrição desta ligação do Chãozão e forneça coaching direto e acionável para o closer.

CONTEXTO DO SCRIPT PLANEJADO:
- Etapas previstas: ${etapas || 'Não informado'}
- Objeções mapeadas: ${objecoes || 'Não informado'}
- Closer: ${closer || 'Não informado'}
- Resultado registrado: ${resultado || 'Ainda não registrado'}

TRANSCRIÇÃO DA LIGAÇÃO:
${transcricao.substring(0, 8000)}

Retorne SOMENTE o objeto JSON abaixo, começando com { e terminando com }:
{
  "nota_geral": number (1-10),
  "resumo_coaching": "string (diagnóstico direto em 2-3 frases)",
  "pontos_fortes": ["string"],
  "pontos_melhora": ["string"],
  "momentos_criticos": [{ "momento": "string (trecho real da conversa)", "analise": "string", "sugestao": "string (como deveria ter sido)" }],
  "aderencia_script": number (0-100),
  "proxima_acao": "string (a 1 coisa mais importante a praticar na próxima ligação)"
}

REGRAS:
- nota_geral: avalie a EXECUÇÃO do closer, não o resultado final
- pontos_fortes: 2 a 3 itens concretos baseados na transcrição
- pontos_melhora: 2 a 3 itens com ação clara e específica
- momentos_criticos: 0 a 2 momentos decisivos identificados na transcrição
- aderencia_script: % de etapas do script que foram executadas
- Seja brutalmente honesto — elogios genéricos não ajudam o closer a crescer`;

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }]
    });
    const raw  = (message.content || []).map(c => c.text || '').join('');
    const text = raw.trim();
    let json;
    try { json = JSON.parse(text); } catch {
      const m = text.match(/\{[\s\S]+\}/);
      if (m) json = JSON.parse(m[0]);
      else throw new Error('JSON inválido na resposta da IA');
    }
    res.json(json);
  } catch(err) {
    console.error('[coaching]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
