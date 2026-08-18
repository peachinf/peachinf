process.env.TZ = 'Asia/Seoul';
const express = require('express');
const { google } = require('googleapis');
const admin = require('firebase-admin');
const app = express();
app.use(express.json());

// CORS
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

const BACKUP_FOLDER_ID = '1tCkA7nT6j3BEyRh0RvrXbrZkUYiNwhiz';

const FILE_IDS = {
  records:       '1TqmaVl39bSlY8OIJpisBnwpQsPThyyJZ',
  weighing:      '1sMvG-YvC02KqVtZNrivQfubzzuhruiqG',
  requests:      '1XUeGlhm9hnJAEYNUP7rxhL8IlrOo2IKQ',
  sell_requests: '1BYx_SCwP2zcUuyjxmlYbhECQN7VuFP0K',
  pricing:       '1ls-mr0gNArlBbb-R3555T3hjdxqyOKEA',
  notice:        '1eRcEHVtfgkNQ0eohjl2zCNWXSaMzNPKo',
  history:       '19Gy9FgUIbsHvLN5-j2lybq-Fg2v291HQ',
  members:       '1S5KjqLpiEtcCwchT_vXWgCGlLGtZDJIz',
  orders:        '1jWNDd-yTXPMtWAl95LIvwmLBDybUZ97v',
  livestockData: '1aqSQe-Z9VE-YFHY7w7BEQSjywjdkutT_',
};

let _weighingQueue = Promise.resolve();
function weighingQueue(fn) {
  const result = _weighingQueue.then(() => fn());
  _weighingQueue = result.catch(() => {});
  return result;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, label, maxAttempts = 4) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      console.error('[RETRY] ' + label + ' 실패 (시도 ' + attempt + '/' + maxAttempts + '): ' + e.message);
      if (attempt < maxAttempts) {
        await sleep(300 * attempt);
      }
    }
  }
  throw lastErr;
}

async function readFile(fileId) {
  return withRetry(async () => {
    const r = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
    return new Promise((resolve, reject) => {
      const chunks = [];
      r.data.on('data', d => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
      r.data.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      r.data.on('error', reject);
    });
  }, 'readFile(' + fileId + ')');
}

async function writeFile(fileId, jsonData) {
  return withRetry(async () => {
    const { Readable } = require('stream');
    const stream = Readable.from([JSON.stringify(jsonData, null, 2)]);
    await drive.files.update({ fileId, media: { mimeType: 'application/json', body: stream } });
  }, 'writeFile(' + fileId + ')');
}

async function sendFCM(title, body, topic) {
  topic = topic || 'transactions';
  try {
    await admin.messaging().send({ topic, notification: { title, body }, android: { priority: 'high' } });
    console.log('FCM 발송 완료 [' + topic + ']: ' + title);
  } catch (e) {
    console.error('FCM 오류:', e.message);
  }
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function backupToday(records) {
  try {
    const { Readable } = require('stream');
    const now = new Date();
    const today = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
    const fileName = 'weighing_records_' + today + '.json';
    const content = JSON.stringify({ records }, null, 2);

    const list = await withRetry(() => drive.files.list({
      q: "'" + BACKUP_FOLDER_ID + "' in parents and name='" + fileName + "' and trashed=false",
      fields: 'files(id)',
    }), 'backupToday-list');

    if (list.data.files.length > 0) {
      await withRetry(() => drive.files.update({
        fileId: list.data.files[0].id,
        media: { mimeType: 'application/json', body: Readable.from([content]) },
      }), 'backupToday-update');
    } else {
      await withRetry(() => drive.files.create({
        requestBody: { name: fileName, parents: [BACKUP_FOLDER_ID] },
        media: { mimeType: 'application/json', body: Readable.from([content]) },
      }), 'backupToday-create');

      const all = await withRetry(() => drive.files.list({
        q: "'" + BACKUP_FOLDER_ID + "' in parents and trashed=false",
        fields: 'files(id, name)',
        orderBy: 'name asc',
      }), 'backupToday-listall');
      const files = all.data.files;
      if (files.length > 7) {
        for (let i = 0; i < files.length - 7; i++) {
          await withRetry(() => drive.files.delete({ fileId: files[i].id }), 'backupToday-delete');
        }
      }
    }
  } catch (e) {
    console.error('백업 오류:', e.message);
  }
}

async function readWeighingRecords() {
  const text = await readFile(FILE_IDS.weighing);
  const data = JSON.parse(text);
  return data.records || [];
}

async function writeWeighingRecords(records) {
  await writeFile(FILE_IDS.weighing, { records });
  backupToday(records).catch(e => console.error('백업 오류(비동기):', e.message));
}

app.get('/records', async (req, res) => {
  try { res.send(await readFile(FILE_IDS.records)); }
  catch (e) { res.status(500).send(e.toString()); }
});

app.post('/records', async (req, res) => {
  try { await writeFile(FILE_IDS.records, req.body); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.toString() }); }
});

app.get('/records/json', async (req, res) => {
  try {
    const records = await readWeighingRecords();
    res.json({ records });
  } catch (e) { res.status(500).send(e.toString()); }
});

app.post('/weighing/save', (req, res) => {
  weighingQueue(async () => {
    const b = req.body;
    const records = await readWeighingRecords();
    const newId = genId();
    records.push({
      id: newId,
      date: b.date||'', type: b.type||'매입', car: b.car||'', company: b.company||'',
      bizType: b.bizType||'',
      item: b.item||'', gross: b.gross||'', tare: b.tare||'',
      grossTime: b.grossTime||'', tareTime: b.tareTime||'',
      lossRate: b.lossRate||'0', loss: b.loss||'', real: b.real||'',
      price: b.price||'', amount: b.amount||'', memo: b.memo||''
    });
    await writeWeighingRecords(records);
    res.json({ ok: true, id: newId });
  }).catch(e => res.status(500).json({ ok: false, error: e.toString() }));
});

app.post('/weighing/update', (req, res) => {
  weighingQueue(async () => {
    const b = req.body;
    const records = await readWeighingRecords();
    let idx = records.findIndex(r => String(r.id) === String(b.id));
    if (idx === -1) {
      idx = records.findIndex(r =>
        r.date === b.date && r.car === b.car &&
        r.grossTime === b.grossTime && String(r.gross) === String(b.gross)
      );
    }
    if (idx === -1) return res.status(404).json({ ok: false, error: '기록을 찾을 수 없음' });
    records[idx] = {
      id: records[idx].id,
      date: b.date, type: b.type, car: b.car, company: b.company,
      bizType: b.bizType||'',
      item: b.item, gross: b.gross, tare: b.tare,
      grossTime: b.grossTime, tareTime: b.tareTime,
      lossRate: b.lossRate, loss: b.loss, real: b.real,
      price: b.price, amount: b.amount, memo: b.memo
    };
    await writeWeighingRecords(records);
    res.json({ ok: true });
  }).catch(e => res.status(500).json({ ok: false, error: e.toString() }));
});

app.post('/weighing/delete', (req, res) => {
  weighingQueue(async () => {
    const { id, date, car, gross, grossTime } = req.body;
    const records = await readWeighingRecords();
    let idx = records.findIndex(r => String(r.id) === String(id));
    if (idx === -1) {
      idx = records.findIndex(r =>
        r.date === date && r.car === car &&
        String(r.gross) === String(gross) && r.grossTime === grossTime
      );
    }
    if (idx === -1) return res.status(404).json({ ok: false, error: '기록을 찾을 수 없음' });
    records.splice(idx, 1);
    await writeWeighingRecords(records);
    res.json({ ok: true });
  }).catch(e => res.status(500).json({ ok: false, error: e.toString() }));
});

let _requestsQueue = Promise.resolve();
function requestsQueue(fn) {
  const result = _requestsQueue.then(() => fn());
  _requestsQueue = result.catch(() => {});
  return result;
}

let _sellQueue = Promise.resolve();
function sellQueue(fn) {
  const result = _sellQueue.then(() => fn());
  _sellQueue = result.catch(() => {});
  return result;
}

app.get('/requests', async (req, res) => {
  try { res.send(await readFile(FILE_IDS.requests)); }
  catch (e) { res.status(500).send(e.toString()); }
});

app.post('/requests/complete', (req, res) => {
  requestsQueue(async () => {
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
  }).catch(e => res.status(500).send(e.toString()));
});

app.post('/sell_requests/complete', (req, res) => {
  sellQueue(async () => {
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
  }).catch(e => res.status(500).send(e.toString()));
});

app.post('/requests/add', (req, res) => {
  requestsQueue(async () => {
    const json = JSON.parse(await readFile(FILE_IDS.requests));
    json.requests.push(req.body);
    await writeFile(FILE_IDS.requests, json);
    res.json({ ok: true });
  }).catch(e => res.status(500).send(e.toString()));
});

app.post('/requests', (req, res) => {
  requestsQueue(async () => {
    const json = JSON.parse(await readFile(FILE_IDS.requests));
    const { id, status } = req.body;
    const r = json.requests.find(r => r.id == id);
    if (r) r.status = status;
    await writeFile(FILE_IDS.requests, json);
    await sendFCM('📦 수거신청 상태변경', '수거신청 상태가 [' + status + '](으)로 변경되었습니다.', 'transactions');
    res.json({ ok: true });
  }).catch(e => res.status(500).send(e.toString()));
});

app.delete('/requests/:id', (req, res) => {
  requestsQueue(async () => {
    const json = JSON.parse(await readFile(FILE_IDS.requests));
    json.requests = json.requests.filter(r => String(r.id) !== String(req.params.id));
    await writeFile(FILE_IDS.requests, json);
    res.json({ ok: true });
  }).catch(e => res.status(500).send(e.toString()));
});

app.delete('/sell_requests/:id', (req, res) => {
  sellQueue(async () => {
    const json = JSON.parse(await readFile(FILE_IDS.sell_requests));
    json.requests = json.requests.filter(r => String(r.id) !== String(req.params.id));
    await writeFile(FILE_IDS.sell_requests, json);
    res.json({ ok: true });
  }).catch(e => res.status(500).send(e.toString()));
});

app.get('/sell_requests', async (req, res) => {
  try { res.send(await readFile(FILE_IDS.sell_requests)); }
  catch (e) { res.status(500).send(e.toString()); }
});

app.post('/sell_requests', (req, res) => {
  sellQueue(async () => {
    const json = JSON.parse(await readFile(FILE_IDS.sell_requests));
    const { id, status } = req.body;
    const r = json.requests.find(r => r.id == id);
    if (r) r.status = status;
    await writeFile(FILE_IDS.sell_requests, json);
    await sendFCM('⚙️ 고철판매 상태변경', '고철판매신청 상태가 [' + status + '](으)로 변경되었습니다.', 'transactions');
    res.json({ ok: true });
  }).catch(e => res.status(500).send(e.toString()));
});

app.post('/sell_requests/add', (req, res) => {
  sellQueue(async () => {
    const json = JSON.parse(await readFile(FILE_IDS.sell_requests));
    json.requests.push(req.body);
    await writeFile(FILE_IDS.sell_requests, json);
    res.json({ ok: true });
  }).catch(e => res.status(500).send(e.toString()));
});

app.get('/pricing', async (req, res) => {
  try { res.send(await readFile(FILE_IDS.pricing)); }
  catch (e) { res.status(500).send(e.toString()); }
});

// ─── 축산정보 수동입력 (사료단가/송아지시세/도축매출 오버라이드) ───
// 구조: { feedPrice: {"2025-01": 518, ...}, calfM: {...}, calfF: {...}, beef: { "025003": {"2025-01": 950}, "025001": {...} } }
let _livestockQueue = Promise.resolve();
function livestockQueue(fn) {
  const result = _livestockQueue.then(() => fn());
  _livestockQueue = result.catch(() => {});
  return result;
}

app.get('/api/livestock-data', async (req, res) => {
  try {
    const text = await readFile(FILE_IDS.livestockData);
    res.send(text);
  } catch (e) {
    res.json({ feedPrice: {}, calfM: {}, calfF: {}, beef: { '025003': {}, '025001': {} } });
  }
});

app.post('/api/livestock-data', (req, res) => {
  livestockQueue(async () => {
    const { type, ym, value, sexCd } = req.body;
    if (!type || !ym || value === undefined) {
      return res.status(400).json({ ok: false, error: '필수값 누락 (type, ym, value)' });
    }
    let data;
    try { data = JSON.parse(await readFile(FILE_IDS.livestockData)); }
    catch { data = { feedPrice: {}, calfM: {}, calfF: {}, beef: { '025003': {}, '025001': {} } }; }

    if (type === 'beef') {
      if (!sexCd) return res.status(400).json({ ok: false, error: 'beef 타입은 sexCd 필요' });
      data.beef = data.beef || { '025003': {}, '025001': {} };
      data.beef[sexCd] = data.beef[sexCd] || {};
      data.beef[sexCd][ym] = value;
    } else {
      data[type] = data[type] || {};
      data[type][ym] = value;
    }

    await writeFile(FILE_IDS.livestockData, data);
    res.json({ ok: true, data });
  }).catch(e => res.status(500).json({ ok: false, error: e.toString() }));
});

let _ordersQueue = Promise.resolve();
function ordersQueue(fn) {
  const result = _ordersQueue.then(() => fn());
  _ordersQueue = result.catch(() => {});
  return result;
}

app.post('/api/orders', (req, res) => {
  ordersQueue(async () => {
    const data = JSON.parse(await readFile(FILE_IDS.orders));
    const order = {
      id: genId(),
      userId: req.body.userId || 'guest',
      date: req.body.date || '',
      items: req.body.items || [],
      total: req.body.total || 0,
      depositor: req.body.depositor || '',
      status: '대기',
      createdAt: new Date().toISOString().slice(0, 16).replace('T', ' ')
    };
    data.orders.push(order);
    await writeFile(FILE_IDS.orders, data);
    await sendFCM('🏪 목장용품 주문', order.depositor + '님 주문이 접수되었습니다.', 'transactions');
    res.json({ ok: true, order });
  }).catch(e => res.status(500).json({ ok: false, error: e.toString() }));
});

app.get('/api/orders', async (req, res) => {
  try {
    const data = JSON.parse(await readFile(FILE_IDS.orders));
    const userId = req.query.userId;
    const orders = data.orders
      .filter(o => !userId || o.userId === userId)
      .sort((a, b) => (b.id > a.id ? 1 : -1));
    res.json({ orders });
  } catch (e) { res.status(500).send(e.toString()); }
});

app.post('/api/orders/:id/cancel', (req, res) => {
  ordersQueue(async () => {
    const data = JSON.parse(await readFile(FILE_IDS.orders));
    const o = data.orders.find(o => String(o.id) === String(req.params.id));
    if (!o) return res.status(404).json({ ok: false, error: '주문을 찾을 수 없음' });
    o.status = '취소';
    await writeFile(FILE_IDS.orders, data);
    res.json({ ok: true });
  }).catch(e => res.status(500).json({ ok: false, error: e.toString() }));
});

app.delete('/api/orders/:id', (req, res) => {
  ordersQueue(async () => {
    const data = JSON.parse(await readFile(FILE_IDS.orders));
    data.orders = data.orders.filter(o => String(o.id) !== String(req.params.id));
    await writeFile(FILE_IDS.orders, data);
    res.json({ ok: true });
  }).catch(e => res.status(500).json({ ok: false, error: e.toString() }));
});

app.post('/pricing', async (req, res) => {
  try { await writeFile(FILE_IDS.pricing, req.body); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.toString() }); }
});

app.get('/notice', async (req, res) => {
  try { res.send(await readFile(FILE_IDS.notice)); }
  catch (e) { res.status(500).send(e.toString()); }
});

app.post('/notice', async (req, res) => {
  try {
    await writeFile(FILE_IDS.notice, req.body);
    await sendFCM(req.body.title || '📢 공지사항', req.body.content || '새 공지가 등록되었습니다.', 'notices');
    res.json({ ok: true });
  } catch (e) { res.status(500).send(e.toString()); }
});

app.get('/history', async (req, res) => {
  try { res.send(await readFile(FILE_IDS.history)); }
  catch (e) { res.status(500).send(e.toString()); }
});

const INQUIRY_FILE_ID = '1sdWRm31RdtvA8mrCu7jg_QdDDom15-lV';

app.get('/inquiries', async (req, res) => {
  try { res.send(await readFile(INQUIRY_FILE_ID)); }
  catch (e) { res.status(500).send(e.toString()); }
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

app.get('/members', async (req, res) => {
  try { res.send(await readFile(FILE_IDS.members)); }
  catch (e) { res.status(500).send(e.toString()); }
});

app.post('/members', async (req, res) => {
  try {
    const { name, phone, address } = req.body;
    if (!name || !phone || !address) {
      return res.status(400).json({ ok: false, error: '필수 항목 누락' });
    }
    const data = JSON.parse(await readFile(FILE_IDS.members));
    const exists = data.members.find(m => m.phone === phone);
    if (exists) {
      return res.status(409).json({ ok: false, error: '이미 가입된 전화번호입니다' });
    }
    data.members.push({
      id: genId(),
      name, phone, address,
      createdAt: new Date().toISOString().slice(0, 16).replace('T', ' ')
    });
    await writeFile(FILE_IDS.members, data);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.toString() }); }
});

// ─── 회원정보 수정 (전화번호 변경 포함) ───────────────
app.post('/members/update', async (req, res) => {
  try {
    const { oldPhone, name, phone, address } = req.body;
    if (!oldPhone || !name || !phone || !address) {
      return res.status(400).json({ ok: false, error: '필수 항목 누락' });
    }
    const data = JSON.parse(await readFile(FILE_IDS.members));
    const member = data.members.find(m => m.phone === oldPhone);
    if (!member) {
      return res.status(404).json({ ok: false, error: '회원을 찾을 수 없습니다' });
    }
    member.name = name;
    member.phone = phone;
    member.address = address;
    // createdAt은 그대로 유지
    await writeFile(FILE_IDS.members, data);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.toString() }); }
});

// ─── 회원탈퇴 (소프트 삭제: status만 변경, 관련 요청/이력은 그대로 유지) ──
app.delete('/members/:phone', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);

    const memberData = JSON.parse(await readFile(FILE_IDS.members));
    const member = memberData.members.find(m => m.phone === phone);
    if (!member) {
      return res.status(404).json({ ok: false, error: '회원을 찾을 수 없습니다' });
    }
    member.status = '탈퇴';
    member.withdrawnAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
    await writeFile(FILE_IDS.members, memberData);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.toString() }); }
});

app.get('/weighing', (req, res) => {
  res.sendFile(__dirname + '/weighing.html');
});

app.listen(process.env.PORT || 8080);
