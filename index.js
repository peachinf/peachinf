const express = require('express'); const fetch = require('node-fetch');
const app = express();
app.get('/test', async (req,res)=>res.send(await (await fetch(req.query.url)).text()));
app.listen(process.env.PORT || 8080);
