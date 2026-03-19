import { useState, useEffect, useCallback, useRef } from "react";
import * as mammoth from "mammoth";

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const fmt = s => `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
const PASS = "admin@123";

const DB = {
  async get(k){try{const r=await window.storage.get(k);return r?JSON.parse(r.value):null}catch{return null}},
  async set(k,v){try{await window.storage.set(k,JSON.stringify(v))}catch{}},
  async list(p){try{const r=await window.storage.list(p);return r?.keys||[]}catch{return[]}},
  async del(k){try{await window.storage.delete(k)}catch{}}
};

async function readFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "txt") return new Promise((ok,no) => {
    const r = new FileReader(); r.onload = e => ok(e.target.result); r.onerror = no; r.readAsText(file);
  });
  if (ext === "docx" || ext === "doc") return new Promise((ok,no) => {
    const r = new FileReader();
    r.onload = async e => { try { const o = await mammoth.extractRawText({arrayBuffer:e.target.result}); ok(o.value.trim()); } catch(e){no(e)} };
    r.onerror = no; r.readAsArrayBuffer(file);
  });
  if (ext === "pdf") return new Promise((ok,no) => {
    const r = new FileReader();
    r.onload = async e => {
      try {
        pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        const pdf = await pdfjsLib.getDocument({data:e.target.result}).promise;
        let t = "";
        for (let i=1;i<=Math.min(pdf.numPages,30);i++) { const pg=await pdf.getPage(i); const ct=await pg.getTextContent(); t+=ct.items.map(x=>x.str).join(" ")+"\n"; }
        ok(t.trim());
      } catch(e){no(e)}
    };
    r.onerror = no; r.readAsArrayBuffer(file);
  });
  throw new Error("Use PDF, DOCX, or TXT only.");
}

async function makeQuiz(text, title) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      model:"claude-sonnet-4-20250514", max_tokens:3000,
      system:`Generate exactly 10 quiz questions from this training document. Mix MCQ and scenario types. Test understanding not memory. Return ONLY this JSON format, nothing else:
{"questions":[{"id":"q1","type":"mcq","text":"Question here?","options":["Option A","Option B","Option C","Option D"],"correct":0,"explanation":"Why this is correct"}]}
correct = 0-indexed number. Make all questions specific to the document content.`,
      messages:[{role:"user", content:`Title: ${title}\n\n${text.slice(0,7000)}`}]
    })
  });
  if (!r.ok) throw new Error("Failed to generate. Status: "+r.status);
  const d = await r.json();
  const raw = d.content?.[0]?.text || "";
  const j = raw.replace(/```json|```/g,"").trim();
  return JSON.parse(j.slice(j.indexOf("{")));
}

function toCSV(attempts, quizzes) {
  const h = ["Agent","ID","Quiz","Score","Percent","Status","Date"];
  const rows = attempts.map(a => {
    const q = quizzes.find(x=>x.id===a.quizId);
    return [a.name,a.eid,q?.title||"?",`${a.score}/${a.total}`,a.pct+"%",a.passed?"Pass":"Fail",new Date(a.ts).toLocaleDateString()];
  });
  const csv = [h,...rows].map(r=>r.map(c=>`"${c}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  Object.assign(document.createElement("a"),{href:url,download:"results.csv"}).click();
  URL.revokeObjectURL(url);
}

// --- Styles ---
const bg = "#0f0f16", card = "#1a1a26", border = "rgba(255,255,255,.07)";
const purple = "#7c6fff", green = "#22c55e", red = "#ef4444", muted = "#6b6b8a", text = "#e8e8f0";
const G = `linear-gradient(135deg,#7c6fff,#a855f7)`;

const cx = (...s) => Object.assign({},...s);
const Card = {background:card,borderRadius:14,border:`1px solid ${border}`,padding:22,marginBottom:14};
const Inp = {width:"100%",background:"#12121e",border:`1px solid ${border}`,borderRadius:9,padding:"11px 14px",fontSize:14,color:text,fontFamily:"inherit",outline:"none"};
const Btn = (b,c,p="12px 22px") => ({background:b,color:c,border:"none",borderRadius:10,padding:p,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"});
const Pill = (c,bg2) => ({fontSize:11,padding:"2px 9px",borderRadius:20,fontWeight:700,color:c,background:bg2,border:`1px solid ${c}44`});

export default function App() {
  const [view, setView]     = useState("home"); // home | admin | quiz | result
  const [quizzes, setQs]    = useState([]);
  const [attempts, setAtts] = useState([]);
  const [auth, setAuth]     = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [pw, setPw]         = useState("");
  const [pwErr, setPwErr]   = useState("");

  // admin state
  const [adminView, setAdminView] = useState("list"); // list | edit | dashboard
  const [editing, setEditing]     = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState("");
  const [copied, setCopied]       = useState(null);
  const fileRef = useRef();

  // quiz state
  const [qid, setQid]         = useState(null);
  const [agentName, setAN]    = useState("");
  const [agentEid, setAEid]   = useState("");
  const [quizStarted, setQS]  = useState(false);
  const [questions, setQns]   = useState([]);
  const [curQ, setCurQ]       = useState(0);
  const [answers, setAnswers] = useState({});
  const [timeLeft, setTL]     = useState(null);
  const [result, setResult]   = useState(null);
  const timerRef = useRef();

  // dashboard filters
  const [fq, setFq] = useState("all");
  const [fa, setFa] = useState("");
  const [lb, setLb] = useState("");

  // toast
  const [toast, setToast] = useState(null);
  const say = (msg, err=false) => { setToast({msg,err}); setTimeout(()=>setToast(null),3500); };

  useEffect(()=>{
    (async()=>{
      const qk = await DB.list("q:"); const qs = (await Promise.all(qk.map(k=>DB.get(k)))).filter(Boolean);
      const ak = await DB.list("a:"); const as = (await Promise.all(ak.map(k=>DB.get(k)))).filter(Boolean);
      setQs(qs); setAtts(as);
      if (await DB.get("auth")) setAuth(true);
    })();
  },[]);

  const saveQ = async q => { await DB.set("q:"+q.id,q); setQs(p=>[...p.filter(x=>x.id!==q.id),q]); };
  const delQ  = async q => { await DB.del("q:"+q.id); setQs(p=>p.filter(x=>x.id!==q.id)); if(editing?.id===q.id)setEditing(null); say("Deleted."); };

  const login = () => {
    if (pw===PASS) { DB.set("auth",true); setAuth(true); setShowPw(false); setPw(""); setPwErr(""); setAdminView("list"); setView("admin"); }
    else { setPwErr("Wrong password"); setPw(""); }
  };
  const logout = () => { DB.del("auth"); setAuth(false); setView("home"); };

  // --- UPLOAD ---
  const handleUpload = async (file) => {
    const ext = file.name.split(".").pop().toLowerCase();
    if (!["pdf","docx","doc","txt"].includes(ext)) { say("Use PDF, DOCX, or TXT only", true); return; }
    setUploading(true); setUploadMsg("Reading document...");
    try {
      const text = await readFile(file);
      if (!text || text.length < 30) throw new Error("Document seems empty.");
      setUploadMsg("AI is generating 10 quiz questions...");
      const title = file.name.replace(/\.[^.]+$/,"");
      const data = await makeQuiz(text, title);
      const quiz = { id:uid(), title, questions:data.questions, passingPct:70, timeLimit:20, randomize:true, published:false, createdAt:Date.now() };
      await saveQ(quiz);
      setEditing(quiz);
      setAdminView("edit");
      say("✅ Quiz ready! Review questions then publish.");
    } catch(e) { say("❌ "+e.message, true); }
    setUploading(false); setUploadMsg("");
  };

  const publish = async (q) => { const u={...q,published:true}; await saveQ(u); setEditing(u); say("Published! Copy the link."); };

  const copyLink = (id) => {
    const url = location.origin+location.pathname+"?quiz="+id;
    navigator.clipboard.writeText(url).catch(()=>{});
    setCopied(id); setTimeout(()=>setCopied(null),2000); say("Link copied!");
  };

  // --- QUIZ ---
  const activeQuiz = quizzes.find(q=>q.id===qid);

  const startQuiz = () => {
    if (!agentName.trim()||!agentEid.trim()) return;
    let qs = [...activeQuiz.questions];
    if (activeQuiz.randomize) qs = qs.sort(()=>Math.random()-.5);
    setQns(qs); setCurQ(0); setAnswers({}); setQS(true);
    if (activeQuiz.timeLimit) {
      setTL(activeQuiz.timeLimit*60);
      timerRef.current = setInterval(()=>setTL(p=>{ if(p<=1){clearInterval(timerRef.current);return 0;} return p-1; }),1000);
    }
  };

  useEffect(()=>{ if(timeLeft===0 && quizStarted) submitQuiz(); },[timeLeft]);

  const submitQuiz = useCallback(()=>{
    clearInterval(timerRef.current);
    let score=0;
    const breakdown = questions.map((q,i)=>{ const sel=answers[i],ok=sel===q.correct; if(ok)score++; return{q,sel,ok}; });
    const pct = Math.round(score/questions.length*100);
    const passed = pct>=(activeQuiz?.passingPct||70);
    const att = { id:uid(), quizId:activeQuiz.id, name:agentName.trim(), eid:agentEid.trim(), score, total:questions.length, pct, passed, breakdown, ts:Date.now() };
    DB.set("a:"+att.id,att); setAtts(p=>[...p,att]); setResult(att); setQS(false); setView("result");
  },[questions, answers, agentName, agentEid, activeQuiz]);

  // --- FILTERS ---
  const filtered = attempts.filter(a=>{
    if (fq!=="all"&&a.quizId!==fq) return false;
    if (fa&&!a.name.toLowerCase().includes(fa.toLowerCase())&&!a.eid.toLowerCase().includes(fa.toLowerCase())) return false;
    return true;
  }).sort((a,b)=>b.ts-a.ts);

  const avg  = filtered.length ? Math.round(filtered.reduce((s,a)=>s+a.pct,0)/filtered.length) : 0;
  const pRate = filtered.length ? Math.round(filtered.filter(a=>a.passed).length/filtered.length*100) : 0;

  // ========== RENDER ==========
  return (
    <div style={{minHeight:"100vh",background:bg,color:text,fontFamily:"system-ui,sans-serif"}}>
      <style>{`
        *{box-sizing:border-box} ::placeholder{color:#3a3a55}
        select option{background:#1a1a26}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes up{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes glow{0%,100%{box-shadow:0 0 20px #7c6fff44}50%{box-shadow:0 0 40px #7c6fff88}}
        input:focus,textarea:focus,select:focus{border-color:#7c6fff88!important;box-shadow:0 0 0 3px #7c6fff18}
        button:hover{opacity:.85} button:active{transform:scale(.98)}
        ::-webkit-scrollbar{width:4px} ::-webkit-scrollbar-thumb{background:#ffffff18;border-radius:4px}
      `}</style>

      {/* Toast */}
      {toast && <div style={{position:"fixed",top:18,right:18,zIndex:9999,padding:"11px 18px",borderRadius:10,fontSize:13,fontWeight:600,background:toast.err?"#1c0808":"#081a0e",color:toast.err?"#f87171":"#4ade80",border:`1px solid ${toast.err?"#f8717133":"#4ade8033"}`,boxShadow:"0 4px 24px #00000066",animation:"up .2s ease"}}>{toast.msg}</div>}

      {/* Password modal */}
      {showPw && (
        <div style={{position:"fixed",inset:0,background:"#000000cc",zIndex:9000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{...Card,maxWidth:380,width:"100%",padding:36,border:`1px solid ${purple}44`,boxShadow:"0 20px 60px #00000088",animation:"up .2s ease"}}>
            <div style={{textAlign:"center",marginBottom:24}}>
              <div style={{fontSize:44,marginBottom:10,animation:"glow 2s ease-in-out infinite",display:"inline-block",borderRadius:16,padding:8}}>🔐</div>
              <h2 style={{fontSize:20,fontWeight:800,marginBottom:4}}>Admin Login</h2>
              <p style={{color:muted,fontSize:13}}>Enter password to continue</p>
            </div>
            <input type="password" value={pw} onChange={e=>{setPw(e.target.value);setPwErr("");}} onKeyDown={e=>e.key==="Enter"&&login()} placeholder="Password" autoFocus style={{...Inp,marginBottom:pwErr?6:14,fontSize:15,letterSpacing:3}}/>
            {pwErr && <p style={{color:red,fontSize:12,marginBottom:10}}>{pwErr}</p>}
            <div style={{display:"flex",gap:8}}>
              <button onClick={login} style={{...Btn(G,"#fff"),flex:2,padding:"12px"}}>Login →</button>
              <button onClick={()=>{setShowPw(false);setPw("");setPwErr("");}} style={{...Btn("#ffffff0a",muted),flex:1,padding:"12px",border:`1px solid ${border}`}}>Cancel</button>
            </div>
            <p style={{marginTop:14,fontSize:11,color:muted,textAlign:"center"}}>Default: <code style={{background:"#ffffff0a",padding:"1px 6px",borderRadius:4,color:purple}}>admin@123</code></p>
          </div>
        </div>
      )}

      {/* ===== HOME ===== */}
      {view==="home" && (
        <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
          <div style={{maxWidth:460,width:"100%",animation:"up .3s ease"}}>
            <div style={{textAlign:"center",marginBottom:40}}>
              <div style={{fontSize:52,marginBottom:14,animation:"glow 3s ease-in-out infinite",display:"inline-block",borderRadius:20,padding:10}}>📋</div>
              <h1 style={{fontSize:36,fontWeight:800,marginBottom:8,background:"linear-gradient(135deg,#fff,#a5b4fc)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>TrainingIQ</h1>
              <p style={{color:muted,fontSize:15,lineHeight:1.65}}>Upload training document · AI creates quiz · Share with agents · Track results</p>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <button onClick={()=>auth?setView("admin"):setShowPw(true)} style={{...Btn(G,"#fff"),padding:"15px",fontSize:16,boxShadow:"0 4px 24px #7c6fff44"}}>
                🔐 &nbsp;Admin — Upload & Manage Quizzes
              </button>
              <div style={{...Card,padding:18}}>
                <p style={{color:muted,fontSize:13,marginBottom:10}}>Agent? Enter your quiz link or ID:</p>
                <div style={{display:"flex",gap:8}}>
                  <input value={lb} onChange={e=>setLb(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")goQuiz();}} placeholder="Paste quiz link or ID…" style={Inp}/>
                  <button onClick={()=>goQuiz()} style={{...Btn(G,"#fff","10px 18px"),whiteSpace:"nowrap"}}>Go →</button>
                </div>
              </div>
              {quizzes.filter(q=>q.published).length>0 && (
                <div style={Card}>
                  <p style={{fontWeight:700,marginBottom:12,fontSize:14}}>Available Quizzes</p>
                  {quizzes.filter(q=>q.published).map(q=>(
                    <div key={q.id} onClick={()=>{setQid(q.id);setView("quiz");}} style={{padding:"11px 14px",borderRadius:9,cursor:"pointer",marginBottom:6,background:"#ffffff05",border:`1px solid ${border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <span style={{fontWeight:600,fontSize:14}}>{q.title}</span>
                      <span style={{color:muted,fontSize:12}}>{q.questions?.length}Q · {q.timeLimit}min</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ===== ADMIN ===== */}
      {view==="admin" && (
        <div style={{minHeight:"100vh",paddingBottom:40}}>
          {/* Header */}
          <div style={{background:card,borderBottom:`1px solid ${border}`,padding:"14px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:100,backdropFilter:"blur(20px)"}}>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <button onClick={()=>setView("home")} style={{...Btn("#ffffff0a",muted,"7px 12px"),border:`1px solid ${border}`,fontSize:12}}>← Home</button>
              <span style={{fontWeight:800,fontSize:17}}>📋 TrainingIQ Admin</span>
            </div>
            <div style={{display:"flex",gap:8}}>
              {adminView!=="list" && <button onClick={()=>setAdminView("list")} style={{...Btn("#ffffff0a",muted,"7px 12px"),border:`1px solid ${border}`,fontSize:12}}>All Quizzes</button>}
              <button onClick={()=>setAdminView("dashboard")} style={{...Btn(adminView==="dashboard"?G:"#ffffff0a",adminView==="dashboard"?"#fff":muted,"7px 12px"),border:`1px solid ${border}`,fontSize:12}}>📊 Results</button>
              <button onClick={logout} style={{...Btn("#ef444418","#f87171","7px 12px"),border:"1px solid #ef444433",fontSize:12}}>Logout</button>
            </div>
          </div>

          <div style={{maxWidth:860,margin:"24px auto",padding:"0 18px"}}>

            {/* ---- LIST VIEW ---- */}
            {adminView==="list" && (
              <div style={{animation:"up .25s ease"}}>
                {/* Upload area */}
                {uploading ? (
                  <div style={{...Card,padding:48,textAlign:"center"}}>
                    <div style={{fontSize:40,marginBottom:16,animation:"spin 1.2s linear infinite",display:"inline-block"}}>⚙️</div>
                    <p style={{fontWeight:700,fontSize:17,marginBottom:6}}>{uploadMsg}</p>
                    <p style={{color:muted,fontSize:13}}>Please wait, this takes about 15–20 seconds...</p>
                    <div style={{width:180,height:3,background:"#ffffff0a",borderRadius:3,margin:"20px auto 0",overflow:"hidden"}}>
                      <div style={{width:"60%",height:"100%",background:G,borderRadius:3,animation:"spin 1.5s ease-in-out infinite"}}/>
                    </div>
                  </div>
                ) : (
                  <div
                    onDragOver={e=>{e.preventDefault();e.currentTarget.style.borderColor=purple;}}
                    onDragLeave={e=>{e.currentTarget.style.borderColor=border;}}
                    onDrop={e=>{e.preventDefault();e.currentTarget.style.borderColor=border;const f=e.dataTransfer.files[0];if(f)handleUpload(f);}}
                    onClick={()=>fileRef.current?.click()}
                    style={{...Card,padding:"48px 24px",textAlign:"center",cursor:"pointer",border:`2px dashed ${border}`,transition:"border-color .2s"}}>
                    <div style={{fontSize:44,marginBottom:14}}>📄</div>
                    <h3 style={{fontSize:18,fontWeight:700,marginBottom:6}}>Upload Training Document</h3>
                    <p style={{color:muted,fontSize:14,marginBottom:20}}>Drag & drop or click — <strong style={{color:text}}>PDF, DOCX, DOC, TXT</strong></p>
                    <button onClick={e=>{e.stopPropagation();fileRef.current?.click();}} style={{...Btn(G,"#fff","11px 30px"),boxShadow:"0 4px 18px #7c6fff44"}}>📁 Choose File</button>
                    <input ref={fileRef} type="file" accept=".pdf,.docx,.doc,.txt" style={{display:"none"}} onChange={e=>{const f=e.target.files[0];e.target.value="";if(f)handleUpload(f);}}/>
                  </div>
                )}

                {/* Quiz list */}
                {quizzes.length>0 && (
                  <div>
                    <p style={{fontWeight:600,color:muted,fontSize:12,textTransform:"uppercase",letterSpacing:.5,marginBottom:10}}>Your Quizzes</p>
                    {[...quizzes].sort((a,b)=>b.createdAt-a.createdAt).map(q=>(
                      <div key={q.id} style={{...Card,padding:16,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10,marginBottom:10}}>
                        <div>
                          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                            <span style={{fontWeight:700,fontSize:15}}>{q.title}</span>
                            <span style={Pill(q.published?green:muted,q.published?"#22c55e18":"#ffffff0a")}>{q.published?"● Live":"○ Draft"}</span>
                          </div>
                          <p style={{color:muted,fontSize:12}}>{q.questions?.length} questions · {new Date(q.createdAt).toLocaleDateString()}</p>
                        </div>
                        <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
                          <button onClick={()=>{setEditing({...q});setAdminView("edit");}} style={{...Btn("#ffffff0a",text,"7px 14px"),border:`1px solid ${border}`,fontSize:12}}>✏️ Edit</button>
                          {q.published
                            ? <button onClick={()=>copyLink(q.id)} style={{...Btn("#7c6fff18",purple,"7px 14px"),border:`1px solid ${purple}44`,fontSize:12}}>{copied===q.id?"✓ Copied!":"🔗 Copy Link"}</button>
                            : <button onClick={()=>publish(q)} style={{...Btn("#22c55e18",green,"7px 14px"),border:`1px solid ${green}44`,fontSize:12}}>🚀 Publish</button>
                          }
                          <button onClick={()=>{if(confirm("Delete '"+q.title+"'?"))delQ(q);}} style={{...Btn("#ef444418","#f87171","7px 14px"),border:"1px solid #ef444433",fontSize:12}}>🗑</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ---- EDIT VIEW ---- */}
            {adminView==="edit" && editing && (
              <div style={{animation:"up .25s ease"}}>
                <div style={{...Card,padding:18,marginBottom:18}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:12}}>
                    <div>
                      <h3 style={{fontWeight:800,fontSize:18,marginBottom:3}}>{editing.title}</h3>
                      <p style={{color:muted,fontSize:12}}>{editing.questions?.length} questions · Edit then publish</p>
                    </div>
                    <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
                      <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:muted}}>
                        Pass%
                        <input type="number" min={10} max={100} defaultValue={editing.passingPct}
                          onChange={e=>{editing.passingPct=+e.target.value;}}
                          style={{...Inp,width:60,padding:"5px 8px",fontSize:13}}/>
                      </label>
                      <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:muted}}>
                        Time
                        <input type="number" min={5} max={120} defaultValue={editing.timeLimit}
                          onChange={e=>{editing.timeLimit=+e.target.value;}}
                          style={{...Inp,width:60,padding:"5px 8px",fontSize:13}}/>
                        min
                      </label>
                      <button onClick={async()=>{await saveQ(editing);say("✅ Saved!");}} style={{...Btn("#ffffff0a",text,"8px 14px"),border:`1px solid ${border}`,fontSize:12}}>Save</button>
                      {!editing.published
                        ? <button onClick={()=>publish(editing)} style={{...Btn("#22c55e",green===editing.published?"#fff":"#fff","8px 16px"),background:"linear-gradient(135deg,#22c55e,#16a34a)",fontSize:13,boxShadow:"0 3px 14px #22c55e33"}}>🚀 Publish Quiz</button>
                        : <button onClick={()=>copyLink(editing.id)} style={{...Btn(G,"#fff","8px 16px"),fontSize:13}}>{copied===editing.id?"✓ Copied!":"🔗 Copy Link"}</button>
                      }
                    </div>
                  </div>
                </div>

                {editing.questions?.map((q,i)=>(
                  <div key={q.id} style={Card}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}>
                      <span style={{...Pill(purple,"#7c6fff18"),fontSize:11}}>{`Q${i+1} · ${q.type==="scenario"?"Scenario":"MCQ"}`}</span>
                    </div>
                    <textarea value={q.text} onChange={e=>{const qs=[...editing.questions];qs[i]={...qs[i],text:e.target.value};setEditing({...editing,questions:qs});}}
                      style={{...Inp,minHeight:64,resize:"vertical",marginBottom:12,lineHeight:1.6}}/>
                    {q.options?.map((opt,oi)=>(
                      <div key={oi} style={{display:"flex",gap:8,alignItems:"center",marginBottom:7}}>
                        <input type="radio" name={`q${i}`} checked={q.correct===oi}
                          onChange={()=>{const qs=[...editing.questions];qs[i]={...qs[i],correct:oi};setEditing({...editing,questions:qs});}}
                          style={{accentColor:green,cursor:"pointer",width:15,height:15,flexShrink:0}}/>
                        <input value={opt} onChange={e=>{const qs=[...editing.questions];const opts=[...qs[i].options];opts[oi]=e.target.value;qs[i]={...qs[i],options:opts};setEditing({...editing,questions:qs});}}
                          style={{...Inp,border:`1px solid ${q.correct===oi?green+"66":border}`,background:q.correct===oi?"#22c55e0a":"#12121e"}}/>
                      </div>
                    ))}
                    <input value={q.explanation||""} onChange={e=>{const qs=[...editing.questions];qs[i]={...qs[i],explanation:e.target.value};setEditing({...editing,questions:qs});}}
                      placeholder="Explanation shown to agents after submitting…"
                      style={{...Inp,marginTop:8,fontSize:12,color:muted,background:"#0d0d18"}}/>
                  </div>
                ))}
              </div>
            )}

            {/* ---- DASHBOARD ---- */}
            {adminView==="dashboard" && (
              <div style={{animation:"up .25s ease"}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:10,marginBottom:20}}>
                  {[["Attempts",filtered.length,"📊",text],["Avg Score",avg+"%","📈",text],["Pass Rate",pRate+"%","✅",green],["Fail Rate",(100-pRate)+"%","❌",red]].map(([l,v,ic,c])=>(
                    <div key={l} style={{...Card,padding:18,textAlign:"center",marginBottom:0}}>
                      <div style={{fontSize:24,marginBottom:8}}>{ic}</div>
                      <div style={{fontSize:26,fontWeight:800,color:c,marginBottom:3}}>{v}</div>
                      <div style={{fontSize:11,color:muted,textTransform:"uppercase",letterSpacing:.4}}>{l}</div>
                    </div>
                  ))}
                </div>
                <div style={{...Card,padding:12,display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
                  <select value={fq} onChange={e=>setFq(e.target.value)} style={{...Inp,flex:"1 1 140px",width:"auto",cursor:"pointer",fontSize:13}}>
                    <option value="all">All Quizzes</option>
                    {quizzes.map(q=><option key={q.id} value={q.id}>{q.title}</option>)}
                  </select>
                  <input value={fa} onChange={e=>setFa(e.target.value)} placeholder="Search agent…" style={{...Inp,flex:"2 1 160px",width:"auto",fontSize:13}}/>
                  <button onClick={()=>toCSV(filtered,quizzes)} style={{...Btn(G,"#fff","9px 16px"),fontSize:12,whiteSpace:"nowrap"}}>Export CSV ↓</button>
                </div>
                {filtered.length===0 ? (
                  <div style={{...Card,padding:40,textAlign:"center",color:muted}}>No results yet. Publish a quiz and share the link.</div>
                ) : (
                  <div style={{...Card,padding:0,overflow:"hidden",marginBottom:0}}>
                    <div style={{overflowX:"auto"}}>
                      <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                        <thead><tr style={{borderBottom:`1px solid ${border}`,background:"#00000033"}}>
                          {["Agent","ID","Quiz","Score","%","Status","Date"].map(h=><th key={h} style={{padding:"11px 14px",textAlign:"left",fontWeight:600,color:muted,whiteSpace:"nowrap"}}>{h}</th>)}
                        </tr></thead>
                        <tbody>{filtered.map((a,i)=>{const q=quizzes.find(x=>x.id===a.quizId);return(
                          <tr key={a.id} style={{borderBottom:`1px solid ${border}`,background:i%2?"#ffffff03":"transparent"}}>
                            <td style={{padding:"11px 14px",fontWeight:600}}>{a.name}</td>
                            <td style={{padding:"11px 14px",color:muted}}>{a.eid}</td>
                            <td style={{padding:"11px 14px",color:muted,maxWidth:140,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{q?.title||"?"}</td>
                            <td style={{padding:"11px 14px"}}>{a.score}/{a.total}</td>
                            <td style={{padding:"11px 14px",fontWeight:700,color:a.passed?green:red}}>{a.pct}%</td>
                            <td style={{padding:"11px 14px"}}><span style={Pill(a.passed?green:red,a.passed?"#22c55e18":"#ef444418")}>{a.passed?"Pass":"Fail"}</span></td>
                            <td style={{padding:"11px 14px",color:muted,whiteSpace:"nowrap"}}>{new Date(a.ts).toLocaleDateString()}</td>
                          </tr>);
                        })}</tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== QUIZ ===== */}
      {view==="quiz" && (()=>{
        if (!activeQuiz) return (
          <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14}}>
            <div style={{fontSize:48}}>❌</div><p style={{color:muted}}>Quiz not found.</p>
            <button onClick={()=>setView("home")} style={Btn(G,"#fff")}>← Home</button>
          </div>
        );
        if (!quizStarted) return (
          <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
            <div style={{...Card,maxWidth:440,width:"100%",padding:40,textAlign:"center",boxShadow:"0 16px 48px #00000066",animation:"up .3s ease"}}>
              <div style={{fontSize:48,marginBottom:14}}>📝</div>
              <h2 style={{fontSize:22,fontWeight:800,marginBottom:6}}>{activeQuiz.title}</h2>
              <p style={{color:muted,fontSize:13,marginBottom:24}}>{activeQuiz.questions?.length} questions · {activeQuiz.timeLimit} min · Pass: {activeQuiz.passingPct}%</p>
              <div style={{display:"flex",flexDirection:"column",gap:9,marginBottom:20,textAlign:"left"}}>
                <input value={agentName} onChange={e=>setAN(e.target.value)} placeholder="Your full name" style={Inp}/>
                <input value={agentEid} onChange={e=>setAEid(e.target.value)} placeholder="Employee ID" style={Inp}/>
              </div>
              <button onClick={startQuiz} disabled={!agentName.trim()||!agentEid.trim()}
                style={{...Btn(G,"#fff"),width:"100%",padding:"14px",fontSize:15,opacity:agentName.trim()&&agentEid.trim()?1:.4,boxShadow:"0 4px 18px #7c6fff44"}}>
                Start Quiz →
              </button>
              <button onClick={()=>setView("home")} style={{display:"block",width:"100%",marginTop:10,background:"none",border:"none",color:muted,cursor:"pointer",fontSize:13}}>← Back</button>
            </div>
          </div>
        );
        const q = questions[curQ]; const total = questions.length;
        return (
          <div style={{minHeight:"100vh",padding:"24px 16px"}}>
            <div style={{maxWidth:660,margin:"0 auto",animation:"up .2s ease"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                <span style={{color:muted,fontSize:13,fontWeight:600}}>Q {curQ+1} / {total}</span>
                {timeLeft!==null && <span style={{fontFamily:"monospace",fontWeight:700,fontSize:15,padding:"4px 10px",borderRadius:7,background:timeLeft<120?"#ef444418":"#ffffff08",color:timeLeft<120?red:muted,border:`1px solid ${timeLeft<120?"#ef444433":border}`}}>⏱ {fmt(timeLeft)}</span>}
              </div>
              <div style={{height:3,background:"#ffffff08",borderRadius:3,marginBottom:22,overflow:"hidden"}}>
                <div style={{height:"100%",width:(curQ/total*100)+"%",background:G,borderRadius:3,transition:"width .3s"}}/>
              </div>
              <div style={{...Card,padding:28,marginBottom:12}}>
                <span style={{...Pill(purple,"#7c6fff18"),fontSize:11,display:"inline-block",marginBottom:14}}>{q?.type==="scenario"?"📌 Scenario":"📋 MCQ"}</span>
                <p style={{fontSize:17,fontWeight:500,lineHeight:1.75,marginBottom:22,marginTop:4}}>{q?.text}</p>
                <div style={{display:"flex",flexDirection:"column",gap:9}}>
                  {q?.options?.map((opt,i)=>{const sel=answers[curQ]===i;return(
                    <div key={i} onClick={()=>setAnswers(p=>({...p,[curQ]:i}))}
                      style={{padding:"13px 16px",borderRadius:10,cursor:"pointer",border:`1.5px solid ${sel?purple:border}`,background:sel?"#7c6fff14":"#ffffff04",display:"flex",gap:12,alignItems:"center",transition:"all .15s"}}>
                      <span style={{width:20,height:20,borderRadius:"50%",border:`2px solid ${sel?purple:border}`,background:sel?purple:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                        {sel && <span style={{width:7,height:7,borderRadius:"50%",background:"#fff"}}/>}
                      </span>
                      <span style={{fontSize:14,lineHeight:1.5}}>{opt}</span>
                    </div>
                  );})}
                </div>
              </div>
              <div style={{display:"flex",gap:9,marginBottom:14}}>
                {curQ>0 && <button onClick={()=>setCurQ(c=>c-1)} style={{...Btn("#ffffff0a",text,"11px 18px"),flex:1,border:`1px solid ${border}`,fontSize:13}}>← Back</button>}
                {curQ<total-1
                  ? <button onClick={()=>setCurQ(c=>c+1)} disabled={answers[curQ]===undefined} style={{...Btn(G,"#fff","11px 18px"),flex:2,fontSize:13,opacity:answers[curQ]!==undefined?1:.35}}>Next →</button>
                  : <button onClick={submitQuiz} disabled={Object.keys(answers).length<total} style={{...Btn("linear-gradient(135deg,#22c55e,#16a34a)","#fff","11px 18px"),flex:2,fontSize:14,opacity:Object.keys(answers).length>=total?1:.35}}>Submit ({Object.keys(answers).length}/{total})</button>
                }
              </div>
              <div style={{display:"flex",gap:5,justifyContent:"center",flexWrap:"wrap"}}>
                {questions.map((_,i)=><div key={i} onClick={()=>setCurQ(i)} style={{width:9,height:9,borderRadius:"50%",cursor:"pointer",background:answers[i]!==undefined?purple:i===curQ?"#7c6fff55":"#ffffff18",transition:"background .2s"}}/>)}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ===== RESULT ===== */}
      {view==="result" && result && (()=>{
        const {score,total,pct,passed,breakdown,name} = result;
        return (
          <div style={{padding:"28px 16px"}}>
            <div style={{maxWidth:620,margin:"0 auto",animation:"up .3s ease"}}>
              <div style={{...Card,padding:"36px 28px",textAlign:"center",marginBottom:22,background:passed?"#22c55e0a":"#ef44440a",border:`1.5px solid ${passed?green+"44":red+"44"}`}}>
                <div style={{fontSize:56,marginBottom:10}}>{passed?"🎉":"😔"}</div>
                <h2 style={{fontSize:26,fontWeight:800,color:passed?green:red,marginBottom:6}}>{passed?"Congratulations!":"Better luck next time"}</h2>
                <p style={{color:muted,marginBottom:18,fontSize:14}}>Great effort, {name}!</p>
                <div style={{fontSize:52,fontWeight:800,color:passed?green:red,lineHeight:1}}>{score}<span style={{fontSize:26,fontWeight:400,color:muted}}>/{total}</span></div>
                <p style={{color:muted,marginTop:8,fontSize:16}}>{pct}% — <strong style={{color:passed?green:red}}>{passed?"✅ PASSED":"❌ FAILED"}</strong></p>
              </div>
              <h3 style={{fontWeight:700,marginBottom:14,fontSize:16}}>📘 Review Answers</h3>
              {breakdown.map((b,i)=>(
                <div key={i} style={{...Card,border:`1.5px solid ${b.ok?green+"33":red+"33"}`,background:b.ok?"#22c55e06":"#ef444406",marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                    <span style={{color:muted,fontSize:12,fontWeight:600}}>Q{i+1}</span>
                    <span style={{fontSize:12,fontWeight:700,color:b.ok?green:red}}>{b.ok?"✅ Correct":"❌ Wrong"}</span>
                  </div>
                  <p style={{fontWeight:500,lineHeight:1.65,marginBottom:10,fontSize:14}}>{b.q.text}</p>
                  {!b.ok && b.sel!==undefined && <p style={{color:red,fontSize:13,marginBottom:5}}>Your answer: {b.q.options[b.sel]}</p>}
                  <p style={{color:green,fontSize:13,fontWeight:600,marginBottom:8}}>✓ Correct: {b.q.options[b.q.correct]}</p>
                  {b.q.explanation && <p style={{color:muted,fontSize:12,lineHeight:1.6,borderTop:`1px solid ${border}`,paddingTop:8,margin:0}}>💡 {b.q.explanation}</p>}
                </div>
              ))}
              <button onClick={()=>{setResult(null);setAN("");setAEid("");setQS(false);setAnswers({});setCurQ(0);setView("home");}}
                style={{...Btn(G,"#fff"),width:"100%",padding:"14px",fontSize:15,marginTop:6,boxShadow:"0 4px 18px #7c6fff44"}}>
                ← Back to Home
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );

  function goQuiz() {
    let id = lb.trim();
    try { id = new URL(id).searchParams.get("quiz")||id; } catch {}
    const q = quizzes.find(x=>x.id===id&&x.published);
    if (q) { setQid(q.id); setView("quiz"); }
    else say("Quiz not found or not published", true);
  }
}
