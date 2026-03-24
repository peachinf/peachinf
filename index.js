const express = require('express');
const { google } = require('googleapis');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

let serviceAccount;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
} else {
  serviceAccount = require('./serviceAccountKey.json');
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const drive = google.drive({
  version: 'v3',
  auth: new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive'] })
});

const FILE_IDS = {
  records:       '1y-QfCGxVR-2_NwCJUbBHpU9Yf2dApyGG',
  records_csv:   '1SxFpdgxaOUGIkW6dCwPdPeUK1z3ddm_E',
  requests:      '11DU2GEJP6jz8S8VfrTYhVRruxSKaeLRR',
  sell_requests: '1LcKY3kBLGZqmpJ4naKiC6ZX9SBLczUFn',
  pricing:       '1A1F5rzzXT2H56UDwYVptDkVoW5KHqTv1',
  notice:        '1y-QBQFcrduZx4dqmTEqun4xsBkv8H9nI',
  history:       '1HRK3B14zYaElV8tga45Ib3qqDeJyR-Nd',
};

async function readFile(fileId) {
  const r = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  return new Promise((resolve, reject) => {
    let data = '';
    r.data.on('data', d => data += d);
    r.data.on('end', () => resolve(data));
    r.data.on('error', reject);
  });
}

async function writeFile(fileId, jsonData) {
  const { Readable } = require('stream');
  const body = JSON.stringify(jsonData, null, 2);
  const stream = Readable.from([body]);
  await drive.files.update({ fileId, media: { mimeType: 'application/json', body: stream } });
}

async function sendFCM(title, body, topic = 'transactions') {
  try {
    await admin.messaging().send({ topic, notification: { title, body }, android: { priority: 'high' } });
    console.log(`FCM 발송 완료 [${topic}]: ${title}`);
  } catch (e) {
    console.error('FCM 오류:', e.message);
  }
}

const CSV_HEADER = '날짜,구분,차량,거래처,품목,총중량,공차,총중량시간,공차시간,감율,감량,인수량,단가,금액,비고';

function parseWeighingCSV(text) {
  var clean = text;
  if (clean.charCodeAt(0) === 0xFEFF) clean = clean.slice(1);
  var lines = clean.trim().split(/\r?\n/).filter(function(l){ return l.trim(); });
  if (lines.length < 2) return [];
  return lines.slice(1).map(function(line, idx) {
    var c = line.split(',');
    while (c.length < 15) c.push('');
    return {
      id:        idx + '_' + c[0].trim() + '_' + c[2].trim(),
      date:      c[0].trim(),  type:      c[1].trim(),
      car:       c[2].trim(),  company:   c[3].trim(),
      item:      c[4].trim(),  gross:     c[5].trim(),
      tare:      c[6].trim(),  grossTime: c[7].trim(),
      tareTime:  c[8].trim(),  lossRate:  c[9].trim(),
      loss:      c[10].trim(), real:      c[11].trim(),
      price:     c[12].trim(), amount:    c[13].trim(),
      memo:      c[14].trim(),
    };
  });
}

async function appendWeighingCSV(b) {
  const { Readable } = require('stream');
  const text = await readFile(FILE_IDS.records_csv);
  var clean = text;
  if (clean.charCodeAt(0) === 0xFEFF) clean = clean.slice(1);
  const row = [
    b.date||'', b.type||'매입', b.car||'', b.company||'',
    b.item||'', b.gross||0, b.tare||0,
    b.grossTime||'', b.tareTime||'',
    b.lossRate||0, b.loss||0, b.real||0,
    b.price||0, b.amount||0, b.memo||''
  ].join(',');
  const newText = clean.trimEnd() + '\n' + row;
  const stream = Readable.from([newText]);
  await drive.files.update({ fileId: FILE_IDS.records_csv, media: { mimeType: 'text/csv', body: stream } });
}

async function writeWeighingCSV(records) {
  const { Readable } = require('stream');
  const rows = records.map(r =>
    [r.date,r.type,r.car,r.company,r.item,r.gross,r.tare,
     r.grossTime,r.tareTime,r.lossRate,r.loss,r.real,r.price,r.amount,r.memo].join(',')
  );
  const newText = CSV_HEADER + '\n' + rows.join('\n');
  const stream = Readable.from([newText]);
  await drive.files.update({ fileId: FILE_IDS.records_csv, media: { mimeType: 'text/csv', body: stream } });
}

app.get('/records', async (req, res) => {
  try { res.send(await readFile(FILE_IDS.records)); } catch (e) { res.status(500).send(e.toString()); }
});

app.post('/records', async (req, res) => {
  try { await writeFile(FILE_IDS.records, req.body); res.json({ ok: true }); } catch (e) { res.status(500).json({ ok: false, error: e.toString() }); }
});

app.post('/weighing/delete', async (req, res) => {
  try {
    const { date, car, gross, grossTime } = req.body;
    const records = parseWeighingCSV(await readFile(FILE_IDS.records_csv));
    const filtered = records.filter(r =>
      !(r.date === date && r.car === car && String(r.gross) === String(gross) && r.grossTime === grossTime)
    );
    await writeWeighingCSV(filtered);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.toString() }); }
});

app.post('/weighing/save', async (req, res) => {
  try { await appendWeighingCSV(req.body); res.json({ ok: true }); } catch (e) { res.status(500).json({ ok: false, error: e.toString() }); }
});

app.post('/weighing/update', async (req, res) => {
  try {
    const b = req.body;
    const records = parseWeighingCSV(await readFile(FILE_IDS.records_csv));
    const idx = parseInt(String(b.id).split('_')[0]);
    if (isNaN(idx) || idx < 0 || idx >= records.length) {
      return res.status(404).json({ ok: false, error: '기록을 찾을 수 없음' });
    }
    records[idx] = {
      id: records[idx].id,
      date: b.date, type: b.type, car: b.car, company: b.company,
      item: b.item, gross: b.gross, tare: b.tare,
      grossTime: b.grossTime, tareTime: b.tareTime,
      lossRate: b.lossRate, loss: b.loss, real: b.real,
      price: b.price, amount: b.amount, memo: b.memo,
    };
    await writeWeighingCSV(records);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.toString() }); }
});

app.get('/records/json', async (req, res) => {
  try { res.json({ records: parseWeighingCSV(await readFile(FILE_IDS.records_csv)) }); } catch (e) { res.status(500).send(e.toString()); }
});

app.get('/requests', async (req, res) => {
  try { res.send(await readFile(FILE_IDS.requests)); } catch (e) { res.status(500).send(e.toString()); }
});

app.post('/requests/complete', async (req, res) => {
  try {
    const { id } = req.body;
    const reqData = JSON.parse(await readFile(FILE_IDS.requests));
    const idx = reqData.requests.findIndex(r => String(r.id) === String(id));
    if (idx === -1) return res.status(404).json({ ok: false });
    const completed = reqData.requests.splice(idx, 1)[0];
    completed.status = "완료"; completed.kind = "수거";
    completed.completed_date = new Date().toISOString().slice(0, 16).replace('T', ' ');
    await writeFile(FILE_IDS.requests, reqData);
    const histData = JSON.parse(await readFile(FILE_IDS.history));
    histData.history.push(completed);
    await writeFile(FILE_IDS.history, histData);
    await sendFCM('📦 수거신청 상태변경', '수거신청이 [완료] 처리되었습니다.', 'transactions');
    res.json({ ok: true });
  } catch (e) { res.status(500).send(e.toString()); }
});

app.post('/sell_requests/complete', async (req, res) => {
  try {
    const { id } = req.body;
    const reqData = JSON.parse(await readFile(FILE_IDS.sell_requests));
    const idx = reqData.requests.findIndex(r => String(r.id) === String(id));
    if (idx === -1) return res.status(404).json({ ok: false });
    const completed = reqData.requests.splice(idx, 1)[0];
    completed.status = "완료"; completed.kind = "판매";
    completed.completed_date = new Date().toISOString().slice(0, 16).replace('T', ' ');
    await writeFile(FILE_IDS.sell_requests, reqData);
    const histData = JSON.parse(await readFile(FILE_IDS.history));
    histData.history.push(completed);
    await writeFile(FILE_IDS.history, histData);
    await sendFCM('⚙️ 고철판매 상태변경', '고철판매신청이 [완료] 처리되었습니다.', 'transactions');
    res.json({ ok: true });
  } catch (e) { res.status(500).send(e.toString()); }
});

app.post('/requests/add', async (req, res) => {
  try {
    const json = JSON.parse(await readFile(FILE_IDS.requests));
    json.requests.push(req.body);
    await writeFile(FILE_IDS.requests, json);
    res.json({ ok: true });
  } catch (e) { res.status(500).send(e.toString()); }
});

app.post('/requests', async (req, res) => {
  try {
    const json = JSON.parse(await readFile(FILE_IDS.requests));
    const { id, status } = req.body;
    const req_ = json.requests.find(r => r.id == id);
    if (req_) req_.status = status;
    await writeFile(FILE_IDS.requests, json);
    await sendFCM('📦 수거신청 상태변경', `수거신청 상태가 [${status}](으)로 변경되었습니다.`, 'transactions');
    res.json({ ok: true });
  } catch (e) { res.status(500).send(e.toString()); }
});

app.delete('/requests/:id', async (req, res) => {
  try {
    const json = JSON.parse(await readFile(FILE_IDS.requests));
    json.requests = json.requests.filter(r => String(r.id) !== String(req.params.id));
    await writeFile(FILE_IDS.requests, json);
    res.json({ ok: true });
  } catch (e) { res.status(500).send(e.toString()); }
});

app.delete('/sell_requests/:id', async (req, res) => {
  try {
    const json = JSON.parse(await readFile(FILE_IDS.sell_requests));
    json.requests = json.requests.filter(r => String(r.id) !== String(req.params.id));
    await writeFile(FILE_IDS.sell_requests, json);
    res.json({ ok: true });
  } catch (e) { res.status(500).send(e.toString()); }
});

app.get('/sell_requests', async (req, res) => {
  try { res.send(await readFile(FILE_IDS.sell_requests)); } catch (e) { res.status(500).send(e.toString()); }
});

app.post('/sell_requests', async (req, res) => {
  try {
    const json = JSON.parse(await readFile(FILE_IDS.sell_requests));
    const { id, status } = req.body;
    const req_ = json.requests.find(r => r.id == id);
    if (req_) req_.status = status;
    await writeFile(FILE_IDS.sell_requests, json);
    await sendFCM('⚙️ 고철판매 상태변경', `고철판매신청 상태가 [${status}](으)로 변경되었습니다.`, 'transactions');
    res.json({ ok: true });
  } catch (e) { res.status(500).send(e.toString()); }
});

app.post('/sell_requests/add', async (req, res) => {
  try {
    const json = JSON.parse(await readFile(FILE_IDS.sell_requests));
    json.requests.push(req.body);
    await writeFile(FILE_IDS.sell_requests, json);
    res.json({ ok: true });
  } catch (e) { res.status(500).send(e.toString()); }
});

app.get('/pricing', async (req, res) => {
  try { res.send(await readFile(FILE_IDS.pricing)); } catch (e) { res.status(500).send(e.toString()); }
});

app.post('/pricing', async (req, res) => {
  try { await writeFile(FILE_IDS.pricing, req.body); res.json({ ok: true }); } catch (e) { res.status(500).json({ ok: false, error: e.toString() }); }
});

app.get('/notice', async (req, res) => {
  try { res.send(await readFile(FILE_IDS.notice)); } catch (e) { res.status(500).send(e.toString()); }
});

app.post('/notice', async (req, res) => {
  try {
    await writeFile(FILE_IDS.notice, req.body);
    await sendFCM(req.body.title || '📢 공지사항', req.body.content || '새 공지가 등록되었습니다.', 'notices');
    res.json({ ok: true });
  } catch (e) { res.status(500).send(e.toString()); }
});

app.get('/history', async (req, res) => {
  try { res.send(await readFile(FILE_IDS.history)); } catch (e) { res.status(500).send(e.toString()); }
});

app.get('/terms', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: sans-serif; font-size: 14px; color: #212121; padding: 20px; line-height: 1.8; max-width: 800px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: bold; border-bottom: 2px solid #1976D2; padding-bottom: 10px; margin-top: 30px; color: #1976D2; }
  h2 { font-size: 16px; font-weight: bold; margin-top: 20px; color: #333; }
  p { margin: 8px 0; }
  ul { padding-left: 20px; }
  li { margin: 5px 0; }
  .updated { color: #888; font-size: 13px; }
</style>
</head>
<body>
<h1>이용약관</h1>
<p class="updated">시행일: 2026년 3월 10일</p>
<h2>제1조 (목적)</h2>
<p>본 약관은 재달(이하 "회사")이 제공하는 전남비닐고철 앱 서비스의 이용과 관련하여 회사와 이용자 간의 권리, 의무 및 책임사항을 규정함을 목적으로 합니다.</p>
<h2>제2조 (서비스의 내용)</h2>
<ul>
  <li>비닐(곤포사일리지랩) 수거 신청 서비스</li>
  <li>고철 판매 신청 서비스</li>
  <li>수거 및 판매 신청 현황 조회 서비스</li>
  <li>공지사항 알림 서비스</li>
</ul>
<h2>제3조 (서비스 이용)</h2>
<p>① 서비스는 전라남도 및 인접 전라권 지역 내 농장주를 대상으로 합니다.</p>
<p>② 별도의 회원가입 없이 앱 설치 후 이용 가능합니다.</p>
<p>③ 허위 정보 입력으로 인한 불이익은 이용자 본인이 부담합니다.</p>
<h2>제4조 (서비스 중단)</h2>
<p>시스템 점검, 천재지변 등 불가피한 사정이 있는 경우 서비스를 일시 중단할 수 있습니다.</p>
<h2>제5조 (면책조항)</h2>
<p>이용자가 입력한 정보의 오류로 인해 발생한 문제에 대해 회사는 책임을 지지 않습니다.</p>
<h2>제6조 (약관의 변경)</h2>
<p>약관 변경 시 앱 내 공지사항을 통해 고지합니다.</p>
<h1>개인정보 취급방침</h1>
<p class="updated">시행일: 2026년 3월 10일</p>
<h2>제1조 (수집하는 개인정보 항목)</h2>
<ul>
  <li>이름(농장명), 연락처, 주소</li>
  <li>신청 내용(품목, 수량 등)</li>
  <li>기기 식별값(FCM 알림 발송 목적)</li>
</ul>
<h2>제2조 (수집 및 이용 목적)</h2>
<ul>
  <li>수거 및 판매 신청 처리</li>
  <li>신청 상태 변경 알림 발송</li>
  <li>공지사항 알림 발송</li>
</ul>
<h2>제3조 (보유 및 이용 기간)</h2>
<p>목적 달성 후 지체 없이 파기합니다.</p>
<h2>제4조 (제3자 제공)</h2>
<p>이용자의 개인정보를 제3자에게 제공하지 않습니다.</p>
<h2>제5조 (개인정보 보호 책임자)</h2>
<p>회사명: 재달</p>
<h2>제6조 (이용자의 권리)</h2>
<p>개인정보 조회, 수정, 삭제를 요청할 수 있습니다.</p>
<h2>제7조 (방침의 변경)</h2>
<p>변경 시 앱 내 공지사항을 통해 고지합니다.</p>
</body>
</html>`);
});

const INQUIRY_FILE_ID = '18EcxubeY1ZCfZjf9ZBx4mTSpFPI2FJU3';

app.get('/inquiries', async (req, res) => {
  try { res.send(await readFile(INQUIRY_FILE_ID)); } catch (e) { res.status(500).send(e.toString()); }
});

app.post('/inquiries/add', async (req, res) => {
  try {
    const data = JSON.parse(await readFile(INQUIRY_FILE_ID));
    data.inquiries.push({
      id: req.body.id || Date.now().toString(),
      category: req.body.category, content: req.body.content,
      answer: null, status: 'PENDING',
      createdAt: new Date().toISOString().slice(0, 16).replace('T', ' ')
    });
    await writeFile(INQUIRY_FILE_ID, data);
    res.json({ ok: true });
  } catch (e) { res.status(500).send(e.toString()); }
});

app.post('/inquiries/reply', async (req, res) => {
  try {
    const { id, answer } = req.body;
    const data = JSON.parse(await readFile(INQUIRY_FILE_ID));
    const inq = data.inquiries.find(i => String(i.id) === String(id));
    if (!inq) return res.status(404).json({ ok: false });
    inq.answer = answer; inq.status = 'ANSWERED';
    await writeFile(INQUIRY_FILE_ID, data);
    await sendFCM('💬 문의 답변 도착', '문의하신 내용에 답변이 등록되었습니다.', 'transactions');
    res.json({ ok: true });
  } catch (e) { res.status(500).send(e.toString()); }
});

app.delete('/inquiries/:id', async (req, res) => {
  try {
    const data = JSON.parse(await readFile(INQUIRY_FILE_ID));
    data.inquiries = data.inquiries.filter(i => String(i.id) !== String(req.params.id));
    await writeFile(INQUIRY_FILE_ID, data);
    res.json({ ok: true });
  } catch (e) { res.status(500).send(e.toString()); }
});

app.get('/weighing', (req, res) => { res.sendFile(__dirname + '/weighing.html'); });

app.listen(process.env.PORT || 8080);
