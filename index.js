const express=require('express'), fetch=require('node-fetch');
const app=express();
app.get('/test', async (req,res)=>{ const r=await fetch(req.query.url); res.send(await r.text()); });
app.listen(process.env.PORT||8080);
