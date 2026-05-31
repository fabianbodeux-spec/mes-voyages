// Magic Link — identification persistante cross-device pour les participants
// Flow : email → token → lien → auto-identification sans mot de passe
const crypto  = require('crypto');
const db      = require('../database');
const run     = db.isAsync ? (fn) => fn() : (fn) => Promise.resolve(fn());

const EXPIRES_MINUTES = 4320; // QW1 : 15 min → 72h (abandons −65 %)
const APP_URL         = process.env.APP_URL || 'https://crewigo.app';
const FROM            = process.env.MEMORY_EMAIL_FROM || 'CrewiGo <noreply@crewigo.app>';

// ── Générer un token et envoyer l'email ────────────────────────────────────────
async function generateAndSend({ email, voyageId, participantNom, shareToken, voyageNom }) {
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + EXPIRES_MINUTES * 60 * 1000).toISOString();

  await run(() => db.magic_links.create({
    email,
    token,
    voyage_id:       voyageId,
    participant_nom: participantNom,
    expires_at:      expiresAt
  }));

  const sendResult = await _sendEmail({ email, token, shareToken, participantNom, voyageNom });
  return { token, ...sendResult };
}

// ── Construire le HTML de l'email ──────────────────────────────────────────────
function _buildHtml({ magicUrl, participantNom, voyageNom }) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#f5f5f5">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 16px">
<table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;max-width:520px">
  <tr><td style="background:#0f172a;padding:28px 32px;text-align:center">
    <div style="color:#f97316;font-size:24px;font-weight:900;letter-spacing:-.5px">Crewi<span style="color:#fff">GO</span></div>
  </td></tr>
  <tr><td style="padding:32px 32px 12px;font-size:16px;color:#1e293b;line-height:1.6">
    Salut <strong>${participantNom}</strong> 👋<br><br>
    Tu as demandé à sauvegarder ton accès au voyage <strong>${voyageNom}</strong>.<br>
    Clique sur le bouton ci-dessous pour te reconnecter depuis n'importe quel appareil — sans mot de passe.
  </td></tr>
  <tr><td style="padding:20px 32px 32px;text-align:center">
    <a href="${magicUrl}" style="display:inline-block;background:#f97316;color:#fff;border-radius:12px;padding:16px 32px;font-size:16px;font-weight:700;text-decoration:none;letter-spacing:-.2px">
      Accéder à mon voyage →
    </a>
    <div style="margin-top:16px;font-size:12px;color:#94a3b8">
      Ce lien est valable 72 heures.<br>
      Si tu n'es pas à l'origine de cette demande, ignore cet email.
    </div>
  </td></tr>
  <tr><td style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0">
    <div style="font-size:11px;color:#94a3b8;text-align:center">
      CrewiGO · Roam together.
    </div>
    <div style="font-size:10px;color:#cbd5e1;text-align:center;margin-top:6px;line-height:1.5">
      Emails acheminés via Resend (sous-traitant, accord de traitement disponible sur
      <a href="https://resend.com/legal/dpa" style="color:#cbd5e1">resend.com/legal/dpa</a>).
      Conformément au RGPD, ton email est utilisé uniquement pour t'envoyer ce lien d'accès.
    </div>
  </td></tr>
</table></td></tr></table></body></html>`;
}

// ── Envoi (Resend → SMTP → console) ───────────────────────────────────────────
async function _sendEmail({ email, token, shareToken, participantNom, voyageNom }) {
  const magicUrl = `${APP_URL}/auth/magic/${token}?v=${shareToken}`;
  const subject  = `🔮 Ton lien magique pour "${voyageNom}"`;
  const html     = _buildHtml({ magicUrl, participantNom, voyageNom });

  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ from: FROM, to: email, subject, html })
    });
    if (!res.ok) throw new Error(`Resend: ${res.status} ${await res.text()}`);
    return { emailSent: true, magicUrl: null };

  } else if (process.env.SMTP_HOST) {
    const nodemailer  = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: +(process.env.SMTP_PORT || 587),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    await transporter.sendMail({ from: FROM, to: email, subject, html });
    return { emailSent: true, magicUrl: null };

  } else {
    // Développement local — pas de config email, retourner le lien directement
    // Remplacer l'APP_URL prod par localhost si pas de var d'env APP_URL configurée
    const devBaseUrl = process.env.APP_URL || 'http://localhost:3000';
    const devMagicUrl = magicUrl.replace(APP_URL, devBaseUrl);
    console.log(`[MagicLink DEV] Email simulé → ${email}`);
    console.log(`[MagicLink DEV] Lien  : ${devMagicUrl}`);
    return { emailSent: false, magicUrl: devMagicUrl };
  }
}

module.exports = { generateAndSend };
