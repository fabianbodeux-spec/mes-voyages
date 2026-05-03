const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE_URL = 'mes-voyages-1.onrender.com';
const docs = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/documents.json'), 'utf8'));

async function uploadDoc(doc) {
  return new Promise((resolve, reject) => {
    const buffer = Buffer.from(doc.contenu, 'base64');
    const boundary = '----FormBoundary' + Math.random().toString(16).slice(2);
    const categorie = doc.categorie || 'autre';
    const filename = doc.nom;
    const mimetype = doc.type_fichier || 'application/octet-stream';

    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="fichier"; filename="${filename}"\r\nContent-Type: ${mimetype}\r\n\r\n`
    );
    const middle = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="categorie"\r\n\r\n${categorie}\r\n--${boundary}--\r\n`
    );
    const body = Buffer.concat([header, buffer, middle]);

    const options = {
      hostname: BASE_URL,
      path: `/api/voyages/${doc.voyage_id}/documents`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`✅ ${doc.nom} → voyage ${doc.voyage_id} : ${data}`);
        resolve();
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  for (const doc of docs) {
    try { await uploadDoc(doc); } catch(e) { console.error(`❌ ${doc.nom} :`, e.message); }
  }
  console.log('\nMigration terminée !');
})();
