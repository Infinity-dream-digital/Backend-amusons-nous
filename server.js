require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
app.listen(PORT);

process.env.JWT_SECRET

// CORS
app.use(cors({
  origin: [process.env.FRONTEND_URL || 'http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500'],
  credentials: true
}));

// Body parsing (sauf pour le webhook Wave qui veut du raw)
app.use((req, res, next) => {
  if (req.path === '/api/wallet/webhook') return next();
  express.json()(req, res, next);
});

// Servir le frontend en production
app.use(express.static(path.join(__dirname, '../frontend')));

// ROUTES API
app.use('/api/auth', require('./routes/auth'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/paris', require('./routes/paris'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', mode: process.env.APP_MODE || 'demo', version: '1.0.0' });
});

// Fallback → frontend (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🎮 Amusons-Nous — Serveur démarré !`);
  console.log(`📡 API     : http://localhost:${PORT}/api`);
  console.log(`🌐 Site    : http://localhost:${PORT}`);
  console.log(`⚙️  Mode    : ${process.env.APP_MODE || 'demo'}`);
  console.log(`\n💡 En mode DEMO, les paiements sont simulés.`);
  console.log(`   Pour activer Wave, mets APP_MODE=production dans .env\n`);
});
