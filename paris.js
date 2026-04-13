const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const auth = require('../middleware/auth');

function genCode() {
  return 'AN-' + Math.random().toString(36).substr(2,6).toUpperCase();
}

// POST /paris/creer — créer un pari
router.post('/creer', auth, (req, res) => {
  const { mise, mode, jeux } = req.body;
  if (!mise || mise < 200) return res.status(400).json({ error: 'Mise minimale : 200 FCFA' });
  if (!jeux || !Array.isArray(jeux) || jeux.length < 1) return res.status(400).json({ error: 'Sélectionnez au moins un jeu' });

  const user = db.prepare('SELECT solde FROM users WHERE id=?').get(req.user.id);
  const commission = Math.ceil(mise * 0.01);
  const total = mise + commission;

  if (user.solde < total)
    return res.status(400).json({ error: `Solde insuffisant. Il te faut ${total} FCFA (mise + 1% commission). Ton solde : ${user.solde} FCFA` });

  const pariId = uuidv4();
  const code = genCode();
  const nombreJeux = jeux.length;

  // Débiter le joueur 1
  db.prepare(`UPDATE users SET solde = solde - ?, updated_at=datetime('now') WHERE id=?`).run(total, req.user.id);
  db.prepare(`INSERT INTO transactions (id,user_id,type,montant,statut,description) VALUES (?,?,?,?,?,?)`
  ).run(uuidv4(), req.user.id, 'perte', total, 'confirme', `Mise pari ${code}`);

  db.prepare(`
    INSERT INTO paris (id,code,joueur1_id,joueur2_id,mise,commission,mode,nombre_jeux,jeux,statut)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(pariId, code, req.user.id, '', mise, commission, mode || '1', nombreJeux, JSON.stringify(jeux), 'en_attente');

  res.json({ success: true, code, pari_id: pariId, total_debite: total, message: `Pari créé ! Partage le code ${code} à ton adversaire.` });
});

// POST /paris/rejoindre — rejoindre un pari avec un code
router.post('/rejoindre', auth, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code requis' });

  const pari = db.prepare('SELECT * FROM paris WHERE code=?').get(code.toUpperCase());
  if (!pari) return res.status(404).json({ error: 'Pari introuvable avec ce code' });
  if (pari.statut !== 'en_attente') return res.status(400).json({ error: 'Ce pari est déjà en cours ou terminé' });
  if (pari.joueur1_id === req.user.id) return res.status(400).json({ error: 'Tu ne peux pas rejoindre ton propre pari !' });

  const total = pari.mise + pari.commission;
  const user = db.prepare('SELECT solde FROM users WHERE id=?').get(req.user.id);
  if (user.solde < total)
    return res.status(400).json({ error: `Solde insuffisant. Il te faut ${total} FCFA. Ton solde : ${user.solde} FCFA` });

  // Débiter le joueur 2 et lancer la partie
  db.prepare(`UPDATE users SET solde = solde - ?, updated_at=datetime('now') WHERE id=?`).run(total, req.user.id);
  db.prepare(`INSERT INTO transactions (id,user_id,type,montant,statut,description) VALUES (?,?,?,?,?,?)`
  ).run(uuidv4(), req.user.id, 'perte', total, 'confirme', `Mise pari ${code}`);
  db.prepare(`UPDATE paris SET joueur2_id=?, statut='en_cours', updated_at=datetime('now') WHERE id=?`).run(req.user.id, pari.id);

  const j1 = db.prepare('SELECT username FROM users WHERE id=?').get(pari.joueur1_id);
  const updatedPari = db.prepare('SELECT * FROM paris WHERE id=?').get(pari.id);
  res.json({ success: true, pari: { ...updatedPari, jeux: JSON.parse(updatedPari.jeux), resultats: JSON.parse(updatedPari.resultats) }, joueur1: j1.username });
});

// GET /paris/:code — voir un pari
router.get('/:code', auth, (req, res) => {
  const pari = db.prepare('SELECT * FROM paris WHERE code=?').get(req.params.code.toUpperCase());
  if (!pari) return res.status(404).json({ error: 'Pari introuvable' });
  if (pari.joueur1_id !== req.user.id && pari.joueur2_id !== req.user.id)
    return res.status(403).json({ error: 'Tu ne participes pas à ce pari' });

  const j1 = db.prepare('SELECT id,username FROM users WHERE id=?').get(pari.joueur1_id);
  const j2 = pari.joueur2_id ? db.prepare('SELECT id,username FROM users WHERE id=?').get(pari.joueur2_id) : null;

  res.json({
    ...pari,
    jeux: JSON.parse(pari.jeux),
    resultats: JSON.parse(pari.resultats),
    joueur1: j1, joueur2: j2
  });
});

// POST /paris/:code/resultat — déclarer le résultat d'un jeu
router.post('/:code/resultat', auth, (req, res) => {
  const { gagnant_jeu } = req.body; // 'j1', 'j2', ou 'draw'
  const pari = db.prepare('SELECT * FROM paris WHERE code=?').get(req.params.code.toUpperCase());
  if (!pari) return res.status(404).json({ error: 'Pari introuvable' });
  if (pari.statut !== 'en_cours') return res.status(400).json({ error: 'Ce pari n\'est pas en cours' });
  if (pari.joueur1_id !== req.user.id && pari.joueur2_id !== req.user.id)
    return res.status(403).json({ error: 'Tu ne participes pas à ce pari' });
  if (!['j1','j2','draw'].includes(gagnant_jeu))
    return res.status(400).json({ error: 'Résultat invalide' });

  let resultats = JSON.parse(pari.resultats);
  let scoreJ1 = pari.score_j1;
  let scoreJ2 = pari.score_j2;

  resultats.push(gagnant_jeu);
  if (gagnant_jeu === 'j1') scoreJ1++;
  if (gagnant_jeu === 'j2') scoreJ2++;

  const toWin = Math.ceil(pari.nombre_jeux / 2);
  const totalJoues = resultats.length;
  const partieTerminee = scoreJ1 >= toWin || scoreJ2 >= toWin || totalJoues >= pari.nombre_jeux;

  if (partieTerminee) {
    let gagnantId = null;
    let gainMontant = pari.mise * 2;

    if (scoreJ1 > scoreJ2) gagnantId = pari.joueur1_id;
    else if (scoreJ2 > scoreJ1) gagnantId = pari.joueur2_id;

    db.prepare(`UPDATE paris SET score_j1=?,score_j2=?,resultats=?,statut='termine',gagnant_id=?,updated_at=datetime('now') WHERE id=?`
    ).run(scoreJ1, scoreJ2, JSON.stringify(resultats), gagnantId, pari.id);

    if (gagnantId) {
      // Créditer le gagnant
      db.prepare(`UPDATE users SET solde=solde+?,total_gains=total_gains+?,parties_jouees=parties_jouees+1,parties_gagnees=parties_gagnees+1,updated_at=datetime('now') WHERE id=?`
      ).run(gainMontant, gainMontant, gagnantId);
      db.prepare(`INSERT INTO transactions (id,user_id,type,montant,statut,description) VALUES (?,?,?,?,?,?)`
      ).run(uuidv4(), gagnantId, 'gain', gainMontant, 'confirme', `Gain pari ${pari.code}`);
      // Perdant : juste stats
      const perdantId = gagnantId === pari.joueur1_id ? pari.joueur2_id : pari.joueur1_id;
      db.prepare(`UPDATE users SET parties_jouees=parties_jouees+1,updated_at=datetime('now') WHERE id=?`).run(perdantId);
    } else {
      // Égalité : rembourser les deux (sans commission)
      const remboursement = pari.mise;
      [pari.joueur1_id, pari.joueur2_id].forEach(uid => {
        db.prepare(`UPDATE users SET solde=solde+?,parties_jouees=parties_jouees+1,updated_at=datetime('now') WHERE id=?`).run(remboursement, uid);
        db.prepare(`INSERT INTO transactions (id,user_id,type,montant,statut,description) VALUES (?,?,?,?,?,?)`
        ).run(uuidv4(), uid, 'gain', remboursement, 'confirme', `Remboursement égalité pari ${pari.code}`);
      });
    }

    // Commission pour la plateforme (déjà prélevée)
    const commissionTotal = pari.commission * 2;
    const j1 = db.prepare('SELECT username FROM users WHERE id=?').get(pari.joueur1_id);
    const j2 = db.prepare('SELECT username FROM users WHERE id=?').get(pari.joueur2_id);
    const gagnantUsername = gagnantId ? db.prepare('SELECT username FROM users WHERE id=?').get(gagnantId).username : null;

    return res.json({
      termine: true, scoreJ1, scoreJ2, gagnant_id: gagnantId,
      gagnant_username: gagnantUsername,
      gain: gagnantId ? gainMontant : null,
      egalite: !gagnantId,
      joueur1: j1.username, joueur2: j2.username,
      commission_plateforme: commissionTotal
    });
  }

  db.prepare(`UPDATE paris SET score_j1=?,score_j2=?,resultats=?,updated_at=datetime('now') WHERE id=?`
  ).run(scoreJ1, scoreJ2, JSON.stringify(resultats), pari.id);

  res.json({ termine: false, scoreJ1, scoreJ2, jeux_joues: totalJoues, jeux_restants: pari.nombre_jeux - totalJoues });
});

// GET /paris — mes paris
router.get('/', auth, (req, res) => {
  const paris = db.prepare(`
    SELECT p.*, u1.username as j1_nom, u2.username as j2_nom
    FROM paris p
    LEFT JOIN users u1 ON p.joueur1_id = u1.id
    LEFT JOIN users u2 ON p.joueur2_id = u2.id
    WHERE p.joueur1_id=? OR p.joueur2_id=?
    ORDER BY p.created_at DESC LIMIT 20
  `).all(req.user.id, req.user.id);
  res.json(paris.map(p => ({ ...p, jeux: JSON.parse(p.jeux), resultats: JSON.parse(p.resultats) })));
});

module.exports = router;
