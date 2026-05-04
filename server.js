require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/generate',   require('./routes/generate'));
app.use('/api/closers',    require('./routes/closers'));
app.use('/api/history',    require('./routes/history'));
app.use('/api/analytics',  require('./routes/analytics'));
app.use('/api/webhook',    require('./routes/webhook'));
app.use('/api/followup',   require('./routes/followup'));
app.use('/api/campaign',   require('./routes/campaign'));
app.use('/api/queue',      require('./routes/queue'));

app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🌱  Chãozão Platform → http://localhost:${PORT}`);
  console.log(`[startup] ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? '✅ presente (' + process.env.ANTHROPIC_API_KEY.slice(0,12) + '...)' : '❌ AUSENTE'}\n`);
});
