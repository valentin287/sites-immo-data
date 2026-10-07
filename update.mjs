// ═══════════════════════════════════════════════════════════════════
//  Robot de mise à jour des sites immobiliers (Benjamin Guéneau, Adèle Kirmann)
//  Lit l'API publique Propriétés-Privées + le widget Immodvisor,
//  puis écrit data/<alias>.json. Lancé chaque jour par GitHub Actions.
//  Règle de sécurité : en cas d'erreur, on NE remplace PAS le fichier
//  existant (les sites gardent la dernière version valide).
// ═══════════════════════════════════════════════════════════════════
import { readFile, writeFile, mkdir } from 'node:fs/promises';

export const CONSEILLERS = ['benjamin.gueneau', 'adele.kirmann'];
const API = 'https://www.proprietes-privees.com/api/';
const UA = { 'User-Agent': 'Mozilla/5.0 (site-vitrine; mise-a-jour quotidienne)', Accept: 'application/json' };

const TYPES = { house: 'Maison', flat: 'Appartement', land: 'Terrain', parking: 'Parking',
  toRenovate: 'À rénover', commercial: 'Local commercial', business: 'Commerce' };
const PETITS = new Set(['de','du','des','la','le','les','sur','en','et','sous','aux','au','l','d']);

export function ville(s) {
  return String(s || '').toLowerCase().replace(/(^|[\s'-])([a-zà-ÿ]+)/g,
    (m, sep, w, i) => sep + ((i > 0 && PETITS.has(w)) ? w : w[0].toUpperCase() + w.slice(1)));
}
export function prixTxt(n) {
  return n ? Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' €' : '';
}
export function titre(t) {
  let s = String(t || '').trim();
  if (s && s === s.toUpperCase()) s = s.charAt(0) + s.slice(1).toLowerCase();
  s = s.replace(/^(exclusivit[ée]|sous offre|à vendre|a vendre|à louer|a louer)\s*[:\-–]\s*/i, '');
  s = s.replace(/\s+(à|a)\s+(louer|vendre)\b/ig, '');
  const parts = s.split(/\s[-–]\s/);
  let out = parts[0];
  if (out.length < 14 && parts[1]) out += ' – ' + parts[1];
  out = out.trim();
  return out.charAt(0).toUpperCase() + out.slice(1);
}
export function bien(x) {
  const n = v => Number(v) || 0;
  const surf = n(x.surfaceInSquareMetres || x.surface), land = n(x.landSurface);
  const loc = x.location || {};
  return {
    ref: x.reference,
    type: TYPES[x.type] || 'Bien',
    titre: titre(x.title),
    ville: ville(loc.label),
    cp: loc.code || '',
    prix: n(x.salePrice),
    prix_txt: x.prestation === 'rent' ? '' : prixTxt(n(x.salePrice)),
    surface: surf ? surf + ' m²' : (land ? land + ' m²' : ''),
    pieces: n(x.roomCount) ? n(x.roomCount) + ' pièces' : '',
    chambres: n(x.bedroomCount) ? n(x.bedroomCount) + ' ch.' : '',
    statut: x.commitment ? 'Sous compromis' : (x.exclusive ? 'Exclusivité' : ''),
    url: 'https://www.proprietes-privees.com/annonces/' + x.reference,
    image: (Array.isArray(x.picturesUrls) && x.picturesUrls[0]) ||
      `https://images.proprietes-privees.com/annonce/${x.reference}/PROPRIETES-PRIVEES-${x.reference}-1.jpg`,
  };
}

async function getJSON(url, fetchFn) {
  const r = await fetchFn(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status} sur ${url}`);
  const j = await r.json();
  if (!j || j.ok === false || j.data === undefined) throw new Error(`Réponse invalide sur ${url}`);
  return j.data;
}

export function lireAvis(html) {
  const count = Number((html.match(/(\d+)\s*avis/i) || [])[1] || 0);
  const note = Number(((html.match(/(\d[.,]\d)\s*(?:\/\s*5|<)/) || [])[1] || '').replace(',', '.'));
  return (count > 0 && note > 0 && note <= 5) ? { count, note } : null;
}

export async function collecter(alias, fetchFn = fetch) {
  const m = await getJSON(API + 'mandataries/' + encodeURIComponent(alias), fetchFn);
  if (!m || !m.id) throw new Error('Conseiller introuvable : ' + alias);
  const enCours = await getJSON(API + 'trades/mandatary/' + m.id, fetchFn);
  const histo = await getJSON(API + 'trades/mandatary/' + m.id + '?sold=true', fetchFn);
  if (!Array.isArray(enCours) || !Array.isArray(histo)) throw new Error('Format des annonces inattendu');

  let avis = null;
  if (m.immodvisorId && m.immodvisorKey) {
    try {
      const u = `https://widget3.immodvisor.com/rating?cid=${m.immodvisorId}&hash=${encodeURIComponent(m.immodvisorKey)}&ctype=company&wording=plural`;
      const r = await fetchFn(u, { headers: { 'User-Agent': UA['User-Agent'] } });
      if (r.ok) avis = lireAvis(await r.text());
    } catch { /* avis gardés depuis le fichier précédent */ }
  }
  return {
    conseiller: alias,
    maj: new Date().toISOString(),
    avis: avis ? { ...avis, url: m.immodvisordReviewUrl || '' } : null,
    enVente: enCours.filter(x => !x.sold && !x.removed && x.prestation !== 'rent').map(bien),
    vendus: histo.filter(x => x.prestation !== 'rent').map(bien),
    loues: histo.filter(x => x.prestation === 'rent').map(bien),
  };
}

async function main() {
  await mkdir('data', { recursive: true });
  let erreurs = 0;
  for (const alias of CONSEILLERS) {
    const fichier = `data/${alias}.json`;
    let ancien = null;
    try { ancien = JSON.parse(await readFile(fichier, 'utf8')); } catch {}
    try {
      const d = await collecter(alias);
      if (!d.avis && ancien && ancien.avis) d.avis = ancien.avis;          // avis indisponibles -> on garde
      // Garde-fou : chute brutale du nombre de biens vendus = format API probablement changé
      if (ancien && ancien.vendus && ancien.vendus.length > 5 && d.vendus.length === 0)
        throw new Error('0 bien vendu renvoyé (avant : ' + ancien.vendus.length + ') — mise à jour annulée');
      const comparable = o => JSON.stringify({ ...o, maj: null });
      if (ancien && comparable(ancien) === comparable(d)) { console.log(`= ${alias} : aucun changement`); continue; }
      await writeFile(fichier, JSON.stringify(d, null, 2) + '\n');
      console.log(`✓ ${alias} : ${d.enVente.length} en vente, ${d.vendus.length} vendus, ${d.loues.length} loués, avis ${d.avis ? d.avis.count + ' (' + d.avis.note + ')' : '—'}`);
    } catch (e) {
      erreurs++;
      console.error(`✗ ${alias} : ${e.message} — fichier précédent conservé`);
    }
  }
  if (erreurs) process.exitCode = 1;   // GitHub envoie un e-mail d'alerte
}

if (import.meta.url === `file://${process.argv[1]}`) main();
