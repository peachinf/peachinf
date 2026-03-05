const express = require('express');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const drive = google.drive({
  version: 'v3',
  auth: new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/drive']
  })
});

// ─── 파일 ID ─────────────────────────────────────────
const FILE_IDS = {
  records:       '1HY-D4Z7dzriFEn6ZOy9kMWajKXv9cKd7',
  requests:      '11DU2GEJP6jz8S8VfrTYhVRruxSKaeLRR',
  sell_requests: '1LcKY3kBLGZqmpJ4naKiC6ZX9SBLczUFn',
  pricing:       '1A1F5rzzXT2H56UDwYVptDkVoW5KHqTv1',
  notice:        '1y-QBQFcrduZx4dqmTEqun4xsBkv8H9nI',
  history:       '1HRK3B14zYaElV8tga45Ib3qqDeJyR-Nd',
};

// ─── 공통 읽기 함수 ───────────────────────────────────
async function readFile(fileId) {
  const r = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );
  return new Promise((resolve, reject) => {
    let data = '';
    r.data.on('data', d => data += d);
    r.data.on('end', () => resolve(data));
    r.data.on('error', reject);
  });
}

// ─── 공통 쓰기 함수 ───────────────────────────────────
async function writeFile(fileId, jsonData) {
  const { Readable } = require('stream');
  const body = JSON.stringify(jsonData, null, 2);
  const stream = Readable.from([body]);
  await drive.files.update({
    fileId,
    media: { mimeType: 'application/json', body: stream }
  });
}

// ─── 기존: 일정 (records) ────────────────────────────
app.get('/records', async (req, res) => {
  try {
    const data = await readFile(FILE_IDS.records);
    res.send(data);
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

// ─── 수거요청 ─────────────────────────────────────────
app.get('/requests', async (req, res) => {
  try {
    const data = await readFile(FILE_IDS.requests);
    res.send(data);
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

// ─── 수거요청 완료 → 이력 이동 ────────────────────────────────
app.post('/requests/complete', async (req, res) => {
  try {
    const { id } = req.body;
    const reqData = JSON.parse(await readFile(FILE_IDS.requests));
    const idx = reqData.requests.findIndex(r => String(r.id) === String(id));
    if (idx === -1) return res.status(404).json({ ok: false });

    const completed = reqData.requests.splice(idx, 1)[0];
    completed.status = "완료";
    completed.kind = "수거";
    completed.completed_date = new Date().toLocaleString('ko-KR');
    await writeFile(FILE_IDS.requests, reqData);

    const histData = JSON.parse(await readFile(FILE_IDS.history));
    histData.history.push(completed);
    await writeFile(FILE_IDS.history, histData);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

app.post('/sell_requests/complete', async (req, res) => {
  try {
    const { id } = req.body;
    const reqData = JSON.parse(await readFile(FILE_IDS.sell_requests));
    const idx = reqData.requests.findIndex(r => String(r.id) === String(id));
    if (idx === -1) return res.status(404).json({ ok: false });

    const completed = reqData.requests.splice(idx, 1)[0];
    completed.status = "완료";
    completed.kind = "판매";
    completed.completed_date = new Date().toLocaleString('ko-KR');
    await writeFile(FILE_IDS.sell_requests, reqData);

    const histData = JSON.parse(await readFile(FILE_IDS.history));
    histData.history.push(completed);
    await writeFile(FILE_IDS.history, histData);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

// ─── 수거요청 추가 ─────────────────────────────────────────────
app.post('/requests/add', async (req, res) => {
  try {
    const data = await readFile(FILE_IDS.requests);
    const json = JSON.parse(data);
    json.requests.push(req.body);
    await writeFile(FILE_IDS.requests, json);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

// ─── 수거요청 상태변경 ─────────────────────────────────────────
app.post('/requests', async (req, res) => {
  try {
    const data = await readFile(FILE_IDS.requests);
    const json = JSON.parse(data);
    const { id, status } = req.body;
    const req_ = json.requests.find(r => r.id == id);
    if (req_) req_.status = status;
    await writeFile(FILE_IDS.requests, json);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

// ─── 수거요청 삭제 ─────────────────────────────────────────────
app.delete('/requests/:id', async (req, res) => {
  try {
    const data = await readFile(FILE_IDS.requests);
    const json = JSON.parse(data);
    json.requests = json.requests.filter(r => String(r.id) !== String(req.params.id));
    await writeFile(FILE_IDS.requests, json);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

// ─── 판매요청 ─────────────────────────────────────────
app.get('/sell_requests', async (req, res) => {
  try {
    const data = await readFile(FILE_IDS.sell_requests);
    res.send(data);
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

app.post('/sell_requests', async (req, res) => {
  try {
    const data = await readFile(FILE_IDS.sell_requests);
    const json = JSON.parse(data);
    const { id, status } = req.body;
    const req_ = json.requests.find(r => r.id == id);
    if (req_) req_.status = status;
    await writeFile(FILE_IDS.sell_requests, json);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

// ─── 판매요청 추가 ─────────────────────────────────────────────
app.post('/sell_requests/add', async (req, res) => {
  try {
    const data = await readFile(FILE_IDS.sell_requests);
    const json = JSON.parse(data);
    json.requests.push(req.body);
    await writeFile(FILE_IDS.sell_requests, json);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

// ─── 단가 ─────────────────────────────────────────────
app.get('/pricing', async (req, res) => {
  try {
    const data = await readFile(FILE_IDS.pricing);
    res.send(data);
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

app.post('/pricing', async (req, res) => {
  try {
    await writeFile(FILE_IDS.pricing, req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

// ─── 공지사항 ─────────────────────────────────────────
app.get('/notice', async (req, res) => {
  try {
    const data = await readFile(FILE_IDS.notice);
    res.send(data);
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

app.post('/notice', async (req, res) => {
  try {
    await writeFile(FILE_IDS.notice, req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

// ─── 거래이력 ─────────────────────────────────────────
app.get('/history', async (req, res) => {
  try {
    const data = await readFile(FILE_IDS.history);
    res.send(data);
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

app.listen(process.env.PORT || 8080);
