'use strict';
/* GET /api/verify?code=STAHL-XXXXX-XXXXX → { valid, amount, code }
   Vérifie la signature du code (sans base de données). Ne dit pas si la carte a déjà été utilisée :
   l'institut tient son registre à partir des e-mails de vente. */
const { verifyCode } = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const code = String((req.query && req.query.code) || '');
  if (!code) { res.statusCode = 400; return res.json({ valid: false, error: 'Code manquant' }); }
  try { return res.json(verifyCode(code)); }
  catch (e) { res.statusCode = 500; return res.json({ valid: false, error: e.message }); }
};
