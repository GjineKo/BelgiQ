'use strict';
const express = require('express');
const {Pool} = require('pg');
const {randomUUID} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const questions = require('./questions');
const translations = require('./question-translations.json');
const locales = require('./public/locales.json');
const categories = ['Géographie','Histoire','Gastronomie','Culture'];
const validLanguage = value => Object.hasOwn(locales,value);
const validNickname = value => typeof value==='string' && value.trim().length>=2 && value.trim().length<=24 && /^[\p{L}\p{N} _.'-]+$/u.test(value.trim());
function publicQuestion(q,language='fr') {
 const translated=translations[language]?.[q.id];
 return {id:q.id,category:locales[language]['cat'+(categories.indexOf(q.category)+1)],text:translated?.[0]||q.text,choices:translated?.[1]||q.choices};
}
function shuffle(items) {const a=[...items];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function createApp(pool) {
 const app=express(),games=new Map(),starts=new Map();
 app.disable('x-powered-by');app.set('trust proxy',1);
 app.use((req,res,next)=>{res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"});next();});
 app.use(express.json({limit:'4kb'}));
 app.use('/api',(req,res,next)=>{res.set('Cache-Control','no-store');next();});
 const languageFor=req=>games.get(req.params.id)?.language||(validLanguage(req.query.lang)?req.query.lang:'fr');
 const fail=(req,res,status,code)=>res.status(status).json({code,error:locales[languageFor(req)][code]});
 const cleanup=setInterval(()=>{const now=Date.now();for(const [id,g]of games)if(now-g.created>3600000)games.delete(id);for(const [ip,r]of starts)if(now-r.since>60000)starts.delete(ip);},60000);cleanup.unref();
 const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
 app.get('/api/health',asyncRoute(async(req,res)=>{await pool.query('SELECT 1');res.json({status:'ok',database:'postgresql',version:2});}));
 app.get('/api/leaderboard',asyncRoute(async(req,res)=>{
  const result=await pool.query(`SELECT id,nickname,score,total,created_at,language,elapsed_ms FROM (
   SELECT DISTINCT ON (lower(nickname)) id,nickname,score,total,created_at,language,elapsed_ms FROM scores
   ORDER BY lower(nickname),score DESC,elapsed_ms ASC NULLS LAST,created_at ASC,id ASC
  ) best ORDER BY score DESC,elapsed_ms ASC NULLS LAST,created_at ASC,id ASC LIMIT 20`);
  res.json(result.rows);
 }));
 app.post('/api/games',(req,res)=>{
  const language=req.body.language||'fr';if(!validLanguage(language))return fail(req,res,400,'languageInvalid');
  if(req.body.nickname!==undefined&&!validNickname(req.body.nickname))return fail(req,res,400,'nicknameInvalid');
  const now=Date.now();let rate=starts.get(req.ip);if(!rate||now-rate.since>60000){rate={since:now,count:0};starts.set(req.ip,rate);}if(++rate.count>30)return fail(req,res,429,'rate');
  if(games.size>=10000)return fail(req,res,503,'busy');
  const chosen=[];for(const cat of categories)chosen.push(...shuffle(questions.filter(q=>q.category===cat)).slice(0,2));chosen.push(...shuffle(questions.filter(q=>!chosen.includes(q))).slice(0,2));
  const id=randomUUID(),selected=shuffle(chosen);games.set(id,{created:now,questions:selected,language,index:0,score:0,elapsedMs:null,saved:null,busy:false});
  res.status(201).json({gameId:id,total:10,language,question:publicQuestion(selected[0],language)});
 });
 app.post('/api/games/:id/answers',(req,res)=>{
  const g=games.get(req.params.id);if(!g||Date.now()-g.created>3600000)return fail(req,res,404,'expired');const q=g.questions[g.index];
  if(!q||req.body.questionId!==q.id||!Number.isInteger(req.body.answer)||req.body.answer<0||req.body.answer>3)return fail(req,res,400,'answerInvalid');
  const correct=req.body.answer===q.answer;if(correct)g.score++;g.index++;if(g.index===10)g.elapsedMs=Math.min(3600000,Date.now()-g.created);
  res.json({correct,answer:q.answer,explanation:translations[g.language]?.[q.id]?.[2]||q.explanation,score:g.score,completed:g.index===10,elapsedMs:g.elapsedMs,next:g.index<10?publicQuestion(g.questions[g.index],g.language):null});
 });
 app.post('/api/games/:id/score',asyncRoute(async(req,res)=>{
  const g=games.get(req.params.id);if(!g||Date.now()-g.created>3600000)return fail(req,res,404,'expired');if(g.index!==10)return fail(req,res,400,'unfinished');
  if(!validNickname(req.body.nickname))return fail(req,res,400,'nicknameInvalid');const nickname=req.body.nickname.trim().normalize('NFC');
  if(g.busy)return fail(req,res,409,'saving');if(g.saved)return res.json(g.saved);g.busy=true;
  try{const r=await pool.query(`INSERT INTO scores(game_id,nickname,score,total,language,elapsed_ms) VALUES($1,$2,$3,10,$4,$5)
   ON CONFLICT(game_id) DO UPDATE SET game_id=EXCLUDED.game_id RETURNING id,nickname,score,total,created_at,language,elapsed_ms`,[req.params.id,nickname,g.score,g.language,g.elapsedMs]);g.saved=r.rows[0];res.status(201).json(g.saved);}finally{g.busy=false;}
 }));
 app.use(express.static(path.join(__dirname,'public'),{maxAge:0}));
 app.use((err,req,res,next)=>{console.error('Request failed:',err.code||err.name);fail(req,res,err.status||503,'unavailable');});return app;
}
function databaseConfig(){return process.env.DATABASE_URL?{connectionString:process.env.DATABASE_URL}:{host:process.env.POSTGRESQL_ADDON_HOST,port:Number(process.env.POSTGRESQL_ADDON_PORT||5432),database:process.env.POSTGRESQL_ADDON_DB,user:process.env.POSTGRESQL_ADDON_USER,password:process.env.POSTGRESQL_ADDON_PASSWORD};}
async function main(){if(!process.env.DATABASE_URL&&!process.env.POSTGRESQL_ADDON_HOST)throw new Error('PostgreSQL environment variables are required');const pool=new Pool({...databaseConfig(),max:3,connectionTimeoutMillis:10000,idleTimeoutMillis:30000});pool.on('error',e=>console.error('Database connection:',e.code));await pool.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));const server=createApp(pool).listen(Number(process.env.PORT||8080),'0.0.0.0',()=>console.log('BelgiQ V2 ready on port '+(process.env.PORT||8080)));process.on('SIGTERM',()=>server.close(()=>pool.end().then(()=>process.exit(0))));}
if(require.main===module)main().catch(e=>{console.error('Startup failed:',e.code||e.message);process.exit(1);});module.exports={createApp,databaseConfig,publicQuestion};
