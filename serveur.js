require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  credentials: true
}));

// Body parsing
app.use(express.json());

// ROUTES API
app.use('/api/auth', require('./routes/auth'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/paris', require('./routes/paris'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', mode: process.env.APP_MODE || 'demo' });
});

// START
app.listen(PORT, () => {
  console.log("Server running on", PORT);
});