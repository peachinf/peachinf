const express = require('express');
const { google } = require('googleapis');

const app = express();
const drive = google.drive({
  version: 'v3',
  auth: new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
  })
});

// 👉 records.json 파일 ID 넣기
const FILE_ID = '여기에_파일ID';

app.get('/records', async (req, res) => {
  try {
    const r = await drive.files.get(
      { fileId: FILE_ID, alt: 'media' },
      { responseType: 'stream' }
    );
    let data = '';
    r.data.on('data', d => data += d);
    r.data.on('end', () => res.send(data));
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

app.listen(process.env.PORT || 8080);
