const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const auth = require('../middleware/auth');
const axios = require('axios');

const MODE = process.env.APP_MODE || 'demo';

// GET /wallet — solde + historique
router.get('/', auth, (req, res) => {
  const user = db.prepare('SELECT id,username,email,solde,total_gains,total_depenses,parties_jouees,parties_gagnees FROM users WHERE id=?').get(req.user.id);
  const transactions = db.prepare(`
    SELECT * FROM transactions WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 50
  `).all(req.user.id);
  res.json({ user, transactions });
});

// POST /wallet/recharge — initier une recharge
router.post('/recharge', auth, (req, res) => {
  const { montant } = req.body;
  if (!montant || montant < 200)
    return res.status(400).json({ error: 'Montant minimum : 200 FCFA' });
  if (montant > 500000)
    return res.status(400).json({ error: 'Montant maximum : 500 000 FCFA' });

  const txId = uuidv4();

  if (MODE === 'demo') {
    // MODE DÉMO : crédite directement sans Wave
    db.prepare(`INSERT INTO transactions (id,user_id,type,montant,statut,description) VALUES (?,?,?,?,?,?)`
    ).run(txId, req.user.id, 'recharge', montant, 'confirme', `Recharge démo de ${montant} FCFA`);
    db.prepare(`UPDATE users SET solde = solde + ?, updated_at = datetime('now') WHERE id = ?`).run(montant, req.user.id);
    const user = db.prepare('SELECT solde FROM users WHERE id=?').get(req.user.id);
    return res.json({ success: true, demo: true, nouveau_solde: user.solde, transaction_id: txId });
  }

  // MODE PRODUCTION : créer un checkout Wave
  // (nécessite un compte Wave Business)
  const wavePayload = {
    currency: 'XOF',
    amount: String(montant),
    error_url: `${process.env.FRONTEND_URL}/wallet?erreur=recharge`,
    success_url: `${process.env.FRONTEND_URL}/wallet?succes=recharge`,
    payment_method_whitelist: ['wave_money'],
    restrict_payer_mobile: '',
    client_reference: txId,
  };

  db.prepare(`INSERT INTO transactions (id,user_id,type,montant,statut,description) VALUES (?,?,?,?,?,?)`
  ).run(txId, req.user.id, 'recharge', montant, 'en_attente', `Recharge Wave de ${montant} FCFA`);

  axios.post('https://api.wave.com/v1/checkout/sessions', wavePayload, {
    headers: { Authorization: `Bearer ${process.env.WAVE_API_KEY}`, 'Content-Type': 'application/json' }
  }).then(r => {
    db.prepare(`UPDATE transactions SET wave_checkout_id=?, updated_at=datetime('now') WHERE id=?`).run(r.data.id, txId);
    res.json({ wave_url: r.data.wave_launch_url, transaction_id: txId });
  }).catch(err => {
    db.prepare(`UPDATE transactions SET statut='echoue', updated_at=datetime('now') WHERE id=?`).run(txId);
    res.status(500).json({ error: 'Erreur Wave : ' + (err.response?.data?.message || err.message) });
  });
});

// POST /wallet/retrait — demande de retrait
router.post('/retrait', auth, (req, res) => {
  const { montant, numero_wave } = req.body;
  if (!montant || montant < 500)
    return res.status(400).json({ error: 'Montant minimum de retrait : 500 FCFA' });
  if (!numero_wave || numero_wave.replace(/\s/g,'').length < 8)
    return res.status(400).json({ error: 'Numéro Wave invalide' });

  const user = db.prepare('SELECT solde FROM users WHERE id=?').get(req.user.id);
  if (user.solde < montant)
    return res.status(400).json({ error: 'Solde insuffisant' });

  const txId = uuidv4();

  if (MODE === 'demo') {
    // MODE DÉMO : retrait simulé
    db.prepare(`UPDATE users SET solde = solde - ?, updated_at=datetime('now') WHERE id=?`).run(montant, req.user.id);
    db.prepare(`INSERT INTO transactions (id,user_id,type,montant,statut,wave_ref,description) VALUES (?,?,?,?,?,?,?)`
    ).run(txId, req.user.id, 'retrait', montant, 'confirme', numero_wave, `Retrait démo vers ${numero_wave}`);
    const updated = db.prepare('SELECT solde FROM users WHERE id=?').get(req.user.id);
    return res.json({ success: true, demo: true, nouveau_solde: updated.solde, message: `Retrait de ${montant} FCFA simulé avec succès` });
  }

  // MODE PRODUCTION : Wave Payout API
  db.prepare(`UPDATE users SET solde = solde - ?, updated_at=datetime('now') WHERE id=?`).run(montant, req.user.id);
  db.prepare(`INSERT INTO transactions (id,user_id,type,montant,statut,wave_ref,description) VALUES (?,?,?,?,?,?,?)`
  ).run(txId, req.user.id, 'retrait', montant, 'en_attente', numero_wave, `Retrait Wave vers ${numero_wave}`);

  axios.post('https://api.wave.com/v1/payout', {
    currency: 'XOF', amount: String(montant),
    receive_amount: String(montant),
    mobile: numero_wave.replace(/\s/g,''),
    name: req.user.username,
    client_reference: txId,
  }, { headers: { Authorization: `Bearer ${process.env.WAVE_API_KEY}` } })
    .then(() => {
      db.prepare(`UPDATE transactions SET statut='confirme', updated_at=datetime('now') WHERE id=?`).run(txId);
      const updated = db.prepare('SELECT solde FROM users WHERE id=?').get(req.user.id);
      res.json({ success: true, nouveau_solde: updated.solde });
    })
    .catch(err => {
      // Rembourser en cas d'échec
      db.prepare(`UPDATE users SET solde = solde + ?, updated_at=datetime('now') WHERE id=?`).run(montant, req.user.id);
      db.prepare(`UPDATE transactions SET statut='echoue', updated_at=datetime('now') WHERE id=?`).run(txId);
      res.status(500).json({ error: 'Erreur retrait Wave : ' + (err.response?.data?.message || err.message) });
    });
});

// POST /wallet/webhook — callback Wave (paiement confirmé)
router.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const secret = process.env.WAVE_WEBHOOK_SECRET;
  // Vérifier la signature Wave (en production)
  const body = JSON.parse(req.body);
  const { type, data } = body;

  if (type === 'checkout.session.completed') {
    const tx = db.prepare('SELECT * FROM transactions WHERE wave_checkout_id=?').get(data.id);
    if (tx && tx.statut === 'en_attente') {
      db.prepare(`UPDATE transactions SET statut='confirme', updated_at=datetime('now') WHERE id=?`).run(tx.id);
      db.prepare(`UPDATE users SET solde = solde + ?, updated_at=datetime('now') WHERE id=?`).run(tx.montant, tx.user_id);
    }
  }
  res.json({ received: true });
});

module.exports = router;
