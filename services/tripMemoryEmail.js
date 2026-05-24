// Email souvenir CrewiRewind — nécessite config SMTP ou RESEND_API_KEY
const db = require('../database');
const run = db.isAsync ? (fn) => fn() : (fn) => Promise.resolve(fn());

function buildEmailHtml(voyage, participants, topPhotoIds, photos, summary) {
  const dest = voyage.destination || voyage.nom;
  const prenoms = participants.map(p => p.nom).join(', ');
  const dates = [voyage.date_debut, voyage.date_fin].filter(Boolean).join(' → ');
  const topPhotoBlocks = topPhotoIds.slice(0, 3).map(pid => {
    const p = photos.find(x => x.id === pid);
    if (!p) return '';
    const imgSrc = p.contenu || '';
    return `<td style="width:33%;padding:4px;text-align:center;vertical-align:top">
      <img src="${imgSrc}" alt="" style="width:100%;border-radius:8px;display:block">
      <div style="font-size:11px;color:#787774;margin-top:4px">${p.auteur || ''}</div>
    </td>`;
  }).join('');

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#f5f5f5">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 16px">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;max-width:600px">
  <tr><td style="background:#F97316;padding:24px 28px">
    <div style="color:#fff;font-size:22px;font-weight:bold">${voyage.nom}</div>
    <div style="color:rgba(255,255,255,.75);font-size:14px;margin-top:4px">${dest} · ${dates}</div>
  </td></tr>
  <tr><td style="padding:24px 28px;font-size:15px;color:#1C1C1C;line-height:1.6">
    Le trip est terminé, les souvenirs commencent maintenant. On a compilé vos meilleures photos et un récap' du voyage. Tout est là, pour toujours.
  </td></tr>
  ${topPhotoBlocks ? `<tr><td style="padding:0 20px 20px"><table width="100%" cellpadding="0" cellspacing="0"><tr>${topPhotoBlocks}</tr></table></td></tr>` : ''}
  ${summary ? `<tr><td style="padding:0 28px 24px">
    <div style="background:#F7F7F5;border-radius:8px;padding:20px;font-size:15px;color:#1C1C1C;line-height:1.6">${summary}</div>
  </td></tr>` : ''}
  <tr><td style="padding:0 28px 28px;text-align:center">
    <a href="${process.env.APP_URL || 'https://crewigo.app'}/partage/${voyage.share_token}" style="display:inline-block;background:#F97316;color:#fff;border-radius:8px;padding:14px 28px;font-size:15px;font-weight:bold;text-decoration:none">Voir mon CrewiRewind</a>
  </td></tr>
  <tr><td style="background:#F7F7F5;padding:16px 28px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="text-align:center;padding:8px"><div style="font-size:18px;font-weight:bold;color:#1C1C1C">${participants.length}</div><div style="font-size:11px;color:#787774">membres</div></td>
      <td style="text-align:center;padding:8px;border-left:1px solid #E9E9E7"><div style="font-size:18px;font-weight:bold;color:#1C1C1C">${photos.length}</div><div style="font-size:11px;color:#787774">photos</div></td>
      <td style="text-align:center;padding:8px;border-left:1px solid #E9E9E7"><div style="font-size:18px;font-weight:bold;color:#F97316">${topPhotoIds.length}</div><div style="font-size:11px;color:#787774">top photos</div></td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#1C1917;padding:16px 28px;text-align:center">
    <div style="color:#fff;font-size:11px">CrewiGo · Roam together.</div>
  </td></tr>
</table></td></tr></table></body></html>`;
}

async function sendMemoryEmail(voyage, participants, topPhotoIds, photos) {
  // Idempotence : ne pas renvoyer si déjà envoyé
  const existing = await run(() => db.trip_memory_emails.getByVoyage(voyage.id));
  if (existing) {
    console.log(`[CrewiRewind] Email déjà envoyé pour voyage ${voyage.id}`);
    return;
  }

  const summary = voyage.memory_summary || null;
  const html = buildEmailHtml(voyage, participants, topPhotoIds, photos, summary);

  const emailsTo = participants
    .map(p => p.email)
    .filter(Boolean)
    .concat(process.env.MEMORY_EMAIL_TO ? [process.env.MEMORY_EMAIL_TO] : [])
    .filter(Boolean);

  if (emailsTo.length === 0) {
    console.log(`[CrewiRewind] Aucun destinataire pour voyage ${voyage.id}`);
    return;
  }

  if (process.env.RESEND_API_KEY) {
    // Envoi via Resend API
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.MEMORY_EMAIL_FROM || 'CrewiGo <noreply@crewigo.app>',
        to: emailsTo,
        subject: `Vos souvenirs de ${voyage.destination || voyage.nom} sont prêts 🎬`,
        html
      })
    });
    if (!res.ok) throw new Error(`Resend: ${res.status} ${await res.text()}`);
  } else if (process.env.SMTP_HOST) {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 587,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    await transporter.sendMail({
      from: process.env.MEMORY_EMAIL_FROM || 'CrewiGo <noreply@crewigo.app>',
      to: emailsTo.join(', '),
      subject: `Vos souvenirs de ${voyage.destination || voyage.nom} sont prêts 🎬`,
      html
    });
  } else {
    console.log(`[CrewiRewind] Email souvenir (simulation — pas de SMTP/Resend) → ${emailsTo.join(', ')}`);
    console.log(`[CrewiRewind] Sujet: Vos souvenirs de ${voyage.destination || voyage.nom} sont prêts`);
  }

  await run(() => db.trip_memory_emails.create(voyage.id, {
    recipients: JSON.stringify(emailsTo),
    status: 'sent'
  }));
  console.log(`[CrewiRewind] Email souvenir envoyé pour voyage ${voyage.id}`);
}

module.exports = { sendMemoryEmail };
