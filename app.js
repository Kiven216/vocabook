
/* Vocab Cycle — minimal offline PWA with IndexedDB storage and 4-choice quiz */

const DB_NAME = 'vocabcycle_db';
const DB_VER = 1;
const STORE = 'words';
const META_STORE = 'meta';

function $(sel){ return document.querySelector(sel); }
function el(tag, attrs={}, children=[]){
  const n = document.createElement(tag);
  Object.entries(attrs).forEach(([k,v]) => {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  });
  children.forEach(c => n.append(c));
  return n;
}

function openDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)){
        const s = db.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('word', 'word', { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)){
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function txPut(storeName, val){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(val);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function txGet(storeName, key){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function txDel(storeName, key){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function txGetAll(storeName){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function resetDB(){
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(true);
    req.onblocked = () => resolve(true);
  });
}

/* seed words from words.json once */
async function ensureSeeded(){
  const seeded = await txGet(META_STORE, 'seeded');
  if (seeded && seeded.value === true) return;

  const res = await fetch('./words.json');
  const data = await res.json();
  const items = data.items || [];
  for (const w of items){
    const existing = await txGet(STORE, w.id);
    if (!existing){
      w.stats = w.stats || { seen:0, correct:0, wrong:0, last_seen:null, mastery:0 };
      w.pronunciation = w.pronunciation || { ipa:null, tts:true };
      await txPut(STORE, w);
    }
  }
  await txPut(META_STORE, { key:'seeded', value:true });
}

function normalizeId(word){
  return word.trim().toLowerCase().replace(/\s+/g,'_').replace(/[^\w_]+/g,'');
}

function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function uniq(arr){ return [...new Set(arr)]; }

/* TTS */
function speak(text){
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = 0.95;
  window.speechSynthesis.speak(u);
}

function allTags(words){
  const tags = [];
  for (const w of words){
    (w.tags || []).forEach(t => tags.push(t));
  }
  return uniq(tags).sort((a,b)=>a.localeCompare(b));
}

function shuffle(a){
  const arr = a.slice();
  for (let i=arr.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* quiz selection: prefer wrong & low mastery */
function scoreForReview(w){
  const s = w.stats || {seen:0, correct:0, wrong:0, mastery:0};
  const wrongBoost = (s.wrong||0) * 3;
  const lowMasteryBoost = Math.max(0, 5 - (s.mastery||0)) * 2;
  const unseenBoost = (s.seen||0) === 0 ? 6 : 0;
  return wrongBoost + lowMasteryBoost + unseenBoost + Math.random();
}

function chooseWordForReview(words){
  const scored = words.map(w => ({ w, score: scoreForReview(w) }));
  scored.sort((a,b)=>b.score-a.score);
  return scored[0]?.w || null;
}

/* build distractors: same tag preferred */
function buildOptions(target, allWords, n=4){
  const correct = target.senses?.[target.core_sense||0]?.definition_cn || (target.senses?.[0]?.definition_cn ?? '—');
  const tags = target.tags || [];
  const poolSame = allWords
    .filter(w => w.id !== target.id)
    .filter(w => (w.tags||[]).some(t => tags.includes(t)))
    .map(w => w.senses?.[w.core_sense||0]?.definition_cn || w.senses?.[0]?.definition_cn)
    .filter(Boolean);

  const poolAny = allWords
    .filter(w => w.id !== target.id)
    .map(w => w.senses?.[w.core_sense||0]?.definition_cn || w.senses?.[0]?.definition_cn)
    .filter(Boolean);

  const distractors = [];
  const source = poolSame.length >= (n-1) ? poolSame : poolSame.concat(poolAny);
  for (const d of shuffle(source)){
    if (d === correct) continue;
    if (!distractors.includes(d)) distractors.push(d);
    if (distractors.length >= n-1) break;
  }
  const opts = shuffle([correct, ...distractors]).map(text => ({ text, isCorrect: text === correct }));
  return { correct, opts };
}

/* UI state */
let WORDS = [];
let CURRENT = null;
let CURRENT_OPTIONS = null;

function setActiveTab(name){
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
}

async function refreshAll(){
  WORDS = await txGetAll(STORE);
  renderLibrary();
  await renderReviewNew();
  fillTagFilter();
}

function fillTagFilter(){
  const sel = $('#tag-filter');
  const tags = allTags(WORDS);
  sel.innerHTML = '';
  sel.append(el('option', { value:'' }, [document.createTextNode('All tags')]));
  for (const t of tags){
    sel.append(el('option', { value:t }, [document.createTextNode(t)]));
  }
}

function renderSensesHtml(w){
  const parts = [];
  const ipa = w.pronunciation?.ipa ? ` • <span class="small">${escapeHtml(w.pronunciation.ipa)}</span>` : '';
  parts.push(`<div class="small">POS: ${escapeHtml(w.pos||'—')}${ipa}</div>`);
  (w.senses||[]).forEach((s, idx) => {
    parts.push(`<div style="margin-top:10px"><b>Sense ${idx+1}</b>: ${escapeHtml(s.definition_cn||'—')}</div>`);
    if (s.cycle_note) parts.push(`<div class="small">${escapeHtml(s.cycle_note)}</div>`);
    if (s.examples?.length){
      parts.push('<ul>');
      s.examples.forEach(ex => parts.push(`<li>${escapeHtml(ex)}</li>`));
      parts.push('</ul>');
    }
  });
  return parts.join('');
}

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function renderLibrary(){
  const q = ($('#search').value||'').trim().toLowerCase();
  const tag = $('#tag-filter').value || '';
  const list = $('#library-list');
  list.innerHTML = '';

  const filtered = WORDS
    .filter(w => !q || (w.word||'').toLowerCase().includes(q))
    .filter(w => !tag || (w.tags||[]).includes(tag))
    .sort((a,b)=>(a.word||'').localeCompare(b.word||''));

  for (const w of filtered){
    const item = el('div', { class:'item', onclick: () => showDetail(w.id) }, [
      document.createTextNode(w.word),
      el('span', { class:'small' }, [document.createTextNode((w.tags||[]).slice(0,2).join(', '))])
    ]);
    list.append(item);
  }
}

async function showDetail(id){
  const w = await txGet(STORE, id);
  if (!w) return;
  $('#detail-word').textContent = w.word;
  $('#detail-meta').textContent = (w.tags||[]).join(' • ');
  $('#detail-body').innerHTML = renderSensesHtml(w);

  $('#detail-speak').onclick = () => speak(w.word);
  $('#detail-edit').onclick = () => fillForm(w);
}

function pickContextSentence(w){
  const s = w.senses?.[w.core_sense||0] || w.senses?.[0];
  if (!s) return '';
  return (s.examples && s.examples.length) ? s.examples[0] : '';
}

async function renderReviewNew(){
  if (!WORDS.length){
    $('#review-word').textContent = 'No words yet.';
    $('#review-context').textContent = 'Add words in the Add tab.';
    $('#review-options').innerHTML = '';
    return;
  }
  CURRENT = chooseWordForReview(WORDS);
  if (!CURRENT) return;

  const { opts } = buildOptions(CURRENT, WORDS, 4);
  CURRENT_OPTIONS = opts;

  $('#review-tags').textContent = (CURRENT.tags||[]).join(' • ');
  $('#review-word').textContent = CURRENT.word;
  $('#review-context').textContent = pickContextSentence(CURRENT);

  $('#review-result').textContent = '';
  $('#review-details').open = false;
  $('#review-explanation').innerHTML = renderSensesHtml(CURRENT);

  const box = $('#review-options');
  box.innerHTML = '';
  opts.forEach((o, idx) => {
    const btn = el('button', { class:'opt', onclick: () => onAnswer(o.isCorrect) }, [
      document.createTextNode(`${String.fromCharCode(65+idx)}. ${o.text}`)
    ]);
    box.append(btn);
  });

  $('#btn-speak').onclick = () => speak(CURRENT.word);
}

async function onAnswer(isCorrect){
  if (!CURRENT) return;
  const stats = CURRENT.stats || { seen:0, correct:0, wrong:0, last_seen:null, mastery:0 };
  stats.seen = (stats.seen||0) + 1;
  stats.last_seen = new Date().toISOString();

  if (isCorrect){
    stats.correct = (stats.correct||0) + 1;
    stats.mastery = Math.min(10, (stats.mastery||0) + 1);
    $('#review-result').textContent = '✅ Correct';
  } else {
    stats.wrong = (stats.wrong||0) + 1;
    stats.mastery = Math.max(0, (stats.mastery||0) - 1);
    $('#review-result').textContent = '❌ Wrong';
    $('#review-details').open = true;
  }

  CURRENT.stats = stats;
  await txPut(STORE, CURRENT);
  WORDS = await txGetAll(STORE);

  // disable option buttons after answer
  document.querySelectorAll('#review-options .opt').forEach(b => b.disabled = true);
}

function fillForm(w){
  setActiveTab('add');
  $('#f-word').value = w.word || '';
  $('#f-pos').value = w.pos || '';
  $('#f-tags').value = (w.tags||[]).join(', ');
  $('#f-ipa').value = w.pronunciation?.ipa || '';
  $('#f-senses').value = JSON.stringify((w.senses||[]), null, 2);
  $('#word-form').dataset.editId = w.id;
  $('#form-status').textContent = `Editing: ${w.word}`;
}

function clearForm(){
  $('#f-word').value = '';
  $('#f-pos').value = '';
  $('#f-tags').value = '';
  $('#f-ipa').value = '';
  $('#f-senses').value = '';
  $('#word-form').dataset.editId = '';
  $('#form-status').textContent = '';
}

function senseTemplate(){
  return [
    {
      "sense_id": 0,
      "definition_cn": "中文释义（核心）",
      "definition_en": "English definition (optional)",
      "examples": [
        "Example sentence 1.",
        "Example sentence 2."
      ],
      "cycle_note": "一句周期提示（可选）"
    }
  ];
}

/* events */
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => setActiveTab(b.dataset.tab)));
$('#search').addEventListener('input', renderLibrary);
$('#tag-filter').addEventListener('change', renderLibrary);
$('#btn-next').addEventListener('click', renderReviewNew);
$('#form-reset').addEventListener('click', clearForm);
$('#sense-template').addEventListener('click', () => {
  const cur = $('#f-senses').value.trim();
  if (cur) return;
  $('#f-senses').value = JSON.stringify(senseTemplate(), null, 2);
});

$('#word-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const word = $('#f-word').value.trim();
  if (!word) return;

  const editId = ($('#word-form').dataset.editId || '').trim();
  const id = editId || normalizeId(word);

  let senses;
  try{
    senses = JSON.parse($('#f-senses').value || '[]');
    if (!Array.isArray(senses) || senses.length === 0) throw new Error('Senses must be a non-empty array.');
  } catch(err){
    $('#form-status').textContent = `Invalid senses JSON: ${err.message}`;
    return;
  }

  const tags = ($('#f-tags').value || '').split(',').map(s => s.trim()).filter(Boolean);
  const pos = $('#f-pos').value.trim() || null;
  const ipa = $('#f-ipa').value.trim() || null;

  const existing = await txGet(STORE, id);
  const stats = existing?.stats || { seen:0, correct:0, wrong:0, last_seen:null, mastery:0 };

  const item = {
    id,
    word,
    pos,
    tags,
    core_sense: 0,
    pronunciation: { ipa, tts: true },
    senses,
    stats
  };

  await txPut(STORE, item);
  $('#form-status').textContent = editId ? 'Updated.' : 'Saved.';
  clearForm();
  await refreshAll();
  setActiveTab('library');
});

$('#btn-export').addEventListener('click', async () => {
  const all = await txGetAll(STORE);
  const payload = { version: 1, exported_at: new Date().toISOString(), items: all };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vocabcycle-export-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$('#btn-import').addEventListener('click', async () => {
  const txt = $('#import-text').value.trim();
  if (!txt){ $('#import-status').textContent = 'Paste JSON first.'; return; }
  let data;
  try{ data = JSON.parse(txt); } catch(e){ $('#import-status').textContent = 'Invalid JSON.'; return; }
  const items = data.items || (Array.isArray(data) ? data : null);
  if (!items || !Array.isArray(items)){ $('#import-status').textContent = 'JSON must have {items:[...]} or be an array.'; return; }

  let count = 0;
  for (const w of items){
    if (!w.word) continue;
    w.id = w.id || normalizeId(w.word);
    w.stats = w.stats || { seen:0, correct:0, wrong:0, last_seen:null, mastery:0 };
    w.pronunciation = w.pronunciation || { ipa:null, tts:true };
    w.core_sense = w.core_sense ?? 0;
    await txPut(STORE, w);
    count++;
  }
  $('#import-status').textContent = `Imported ${count} words.`;
  $('#import-text').value = '';
  await refreshAll();
});

$('#btn-reset').addEventListener('click', async () => {
  if (!confirm('Reset all local data on this device?')) return;
  await resetDB();
  location.reload();
});

/* register service worker */
if ('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

/* init */
(async function init(){
  await ensureSeeded();
  await refreshAll();
  // init detail pane
  if (WORDS[0]) await showDetail(WORDS[0].id);
})();
