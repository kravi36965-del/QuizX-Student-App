const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const QUESTIONS = require("./question-bank");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: false } });
const rooms = new Map();
const RECONNECT_GRACE_MS = 60_000;
const DATA_DIR = path.join(__dirname, "data");
const HISTORY_FILE = path.join(DATA_DIR, "quiz-history.json");
const STUDENTS_FILE = path.join(DATA_DIR, "students.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, "[]");
if (!fs.existsSync(STUDENTS_FILE)) fs.writeFileSync(STUDENTS_FILE, "[]");
app.use(express.json({ limit: "100kb" }));
function readStudents(){ try{return JSON.parse(fs.readFileSync(STUDENTS_FILE,"utf8"));}catch{return [];} }
function writeStudents(items){const tmp=STUDENTS_FILE+".tmp";fs.writeFileSync(tmp,JSON.stringify(items,null,2));fs.renameSync(tmp,STUDENTS_FILE);}
const EXAM_PRESETS = {
  "JEE Main": {seconds:90,categories:["Physics","Chemistry","Mathematics","Quantitative Aptitude","Logical Reasoning"]},
  "NEET": {seconds:60,categories:["Physics","Chemistry","Biology","Quantitative Aptitude"]},
  "SSC CGL": {seconds:45,categories:["Quantitative Aptitude","Logical Reasoning","General Awareness","English"]},
  "SSC CHSL": {seconds:45,categories:["Quantitative Aptitude","Logical Reasoning","General Awareness","English"]},
  "UPSC CSE": {seconds:60,categories:["General Studies","Current Affairs","Logical Reasoning"]},
  "Railway (RRB)": {seconds:45,categories:["Quantitative Aptitude","Logical Reasoning","General Awareness"]},
  "Banking (IBPS/SBI)": {seconds:45,categories:["Quantitative Aptitude","Logical Reasoning","English","Banking Awareness"]},
  "GATE": {seconds:120,categories:["Engineering Mathematics","Core Engineering","Quantitative Aptitude"]},
  "State PSC": {seconds:60,categories:["General Studies","Current Affairs","Logical Reasoning"]},
  "Police / Defence": {seconds:45,categories:["Quantitative Aptitude","Logical Reasoning","General Awareness"]},
  "Placement Aptitude": {seconds:60,categories:["Quantitative Aptitude","Logical Reasoning","English"]},
  "General Aptitude": {seconds:60,categories:["Quantitative Aptitude","Logical Reasoning"]}
};
function publicStudent(st){const {passwordHash,...safe}=st;return safe;}
app.post("/api/student/register", (req,res)=>{const name=String(req.body.name||"").trim().slice(0,60),email=String(req.body.email||"").trim().toLowerCase(),password=String(req.body.password||""),field=String(req.body.field||"General Aptitude"),study=String(req.body.study||"").trim().slice(0,100);if(!name||!email||password.length<6||!study)return res.status(400).json({error:"Name, email, current study and password (6+ characters) are required."});const students=readStudents();if(students.some(x=>x.email===email))return res.status(409).json({error:"An account with this email already exists. Please log in."});const st={id:crypto.randomUUID(),name,email,field,study,passwordHash:crypto.createHash("sha256").update(password).digest("hex"),createdAt:new Date().toISOString(),quizHistory:[],interviewHistory:[]};students.push(st);writeStudents(students);res.json({student:publicStudent(st)});});
app.post("/api/student/login",(req,res)=>{const email=String(req.body.email||"").trim().toLowerCase(),password=String(req.body.password||""),hash=crypto.createHash("sha256").update(password).digest("hex"),st=readStudents().find(x=>x.email===email&&x.passwordHash===hash);if(!st)return res.status(401).json({error:"Email or password is incorrect."});res.json({student:publicStudent(st)});});
app.get("/api/student/:id",(req,res)=>{const st=readStudents().find(x=>x.id===req.params.id);if(!st)return res.status(404).json({error:"Student not found."});res.json({student:publicStudent(st)});});
app.get("/api/student/:id/questions",(req,res)=>{const students=readStudents(),st=students.find(x=>x.id===req.params.id);if(!st)return res.status(404).json({error:"Please log in again."});const field=String(req.query.field||st.field),count=Math.max(5,Math.min(100,Number(req.query.count)||10)),preset=EXAM_PRESETS[field]||EXAM_PRESETS["General Aptitude"];let bank=QUESTIONS.filter(q=>preset.categories.includes(q.category));if(!bank.length)bank=QUESTIONS;const shuffled=seededShuffle(bank,Date.now()).slice(0,Math.min(count,bank.length));res.json({field,secondsPerQuestion:preset.seconds,questions:shuffled.map(({answer,...q})=>q),answerKey:shuffled.map(q=>q.answer),coverageNote:bank.length<count?`This starter bank currently has ${bank.length} matching questions. More subject-specific questions should be added for full ${field} coverage.`:"Questions are selected from the included question bank; expand the bank for complete exam coverage."});});
app.post("/api/student/:id/quiz-result",(req,res)=>{const students=readStudents(),st=students.find(x=>x.id===req.params.id);if(!st)return res.status(404).json({error:"Student not found."});const item={id:crypto.randomUUID(),field:String(req.body.field||st.field),count:Number(req.body.count)||0,correct:Number(req.body.correct)||0,accuracy:Number(req.body.accuracy)||0,completedAt:new Date().toISOString()};st.quizHistory=st.quizHistory||[];st.quizHistory.unshift(item);writeStudents(students);res.json({ok:true,result:item});});
app.post("/api/student/:id/interview-result",(req,res)=>{const students=readStudents(),st=students.find(x=>x.id===req.params.id);if(!st)return res.status(404).json({error:"Student not found."});st.interviewHistory=st.interviewHistory||[];st.interviewHistory.unshift({id:crypto.randomUUID(),role:String(req.body.role||"Software Engineer"),answers:req.body.answers||[],completedAt:new Date().toISOString()});writeStudents(students);res.json({ok:true});});

function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); }
  catch { return []; }
}
function writeHistory(items) {
  const tmp = HISTORY_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2));
  fs.renameSync(tmp, HISTORY_FILE);
}
function makeToken() { return crypto.randomBytes(24).toString("hex"); }
function makeCode() {
  const oldCodes = new Set(readHistory().slice(0, 500).map(x => x.roomCode));
  let code;
  do code = String(Math.floor(100000 + Math.random() * 900000));
  while (rooms.has(code) || oldCodes.has(code));
  return code;
}
function sanitizeQuestions() {
  return QUESTIONS.map(({ answer, ...q }) => q);
}

function seededShuffle(items, seed) {
  const a = items.slice();
  let x = Number(seed) || 1;
  for (let i = a.length - 1; i > 0; i--) {
    x = (x * 1664525 + 1013904223) >>> 0;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function selectRoomQuestions(code) {
  const picked = seededShuffle(QUESTIONS, code).slice(0, Math.min(45, QUESTIONS.length));
  return picked.map(q => ({...q}));
}

function publicRoom(room) {
  return {
    code: room.code,
    quizName: room.quizName,
    maxPlayers: room.maxPlayers,
    hostId: room.hostId,
    started: room.started,
    ended: room.ended,
    startAt: room.startAt,
    endAt: room.endAt,
    durationMinutes: room.durationMinutes,
    submittedCount: [...room.players.values()].filter(p => p.result).length,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, language: p.language,
      submitted: !!p.result
    }))
  };
}
function sendQuizState(socket, room, isHost) {
  if (room.ended) return socket.emit("quizEnded", { result: findPlayerResult(room, socket.data.sessionToken) });
  if (!room.started) return;
  if (isHost) return socket.emit("quizState", { quizName: room.quizName, startAt: room.startAt, endAt: room.endAt, durationMinutes: room.durationMinutes });
  socket.emit("quizState", {
    quizName: room.quizName, startAt: room.startAt, endAt: room.endAt,
    durationMinutes: room.durationMinutes, questions: room.questions.map(({answer, ...q}) => q)
  });
}
function findPlayerResult(room, token) {
  const p = [...room.players.values()].find(x => x.token === token);
  return p ? p.result || null : null;
}
function guidanceFor(stats, accuracy) {
  const advice = [];
  if (accuracy >= 85) advice.push("Excellent accuracy. Move toward harder timed sets and mixed mock tests.");
  else if (accuracy >= 70) advice.push("Good base. Reduce avoidable mistakes and practice under a strict timer.");
  else if (accuracy >= 50) advice.push("Build fundamentals first, then add timed practice in short sets.");
  else advice.push("Start with concept revision and easy practice; increase difficulty gradually.");
  if (stats["Quantitative Aptitude"]) {
    const a = stats["Quantitative Aptitude"].accuracy;
    if (a < 70) advice.push("Quantitative Aptitude needs improvement: revise percentages, ratios, averages, arithmetic and calculation shortcuts.");
    else advice.push("Quantitative Aptitude is a strength: focus on speed and multi-step problems.");
  }
  if (stats["Logical Reasoning"]) {
    const a = stats["Logical Reasoning"].accuracy;
    if (a < 70) advice.push("Logical Reasoning needs improvement: practice series, coding-decoding, directions and deduction questions.");
    else advice.push("Logical Reasoning is a strength: add advanced puzzles and time-pressure sets.");
  }
  if (stats.unanswered > 0) advice.push(`You left ${stats.unanswered} question(s) unanswered. Work on time allocation and skip/return strategy.`);
  if (stats.wrong > 0) advice.push(`Review ${stats.wrong} incorrect answer(s) and write down the reason for each mistake before your next mock.`);
  return advice;
}
function calculateResult(room, player, payload = {}) {
  const answers = Array.isArray(payload.answers) ? payload.answers : [];
  let correct = 0, wrong = 0, unanswered = 0;
  const categories = {};
  room.questions.forEach((q, i) => {
    const raw = answers[i];
    const answer = Number.isInteger(raw) ? raw : null;
    const cat = q.category || "General";
    categories[cat] ||= { total: 0, correct: 0, wrong: 0, unanswered: 0, accuracy: 0 };
    categories[cat].total++;
    if (answer === null || answer < 0) {
      unanswered++; categories[cat].unanswered++;
    } else if (answer === q.answer) {
      correct++; categories[cat].correct++;
    } else {
      wrong++; categories[cat].wrong++;
    }
  });
  Object.values(categories).forEach(s => {
    const attempted = s.correct + s.wrong;
    s.accuracy = attempted ? Math.round(s.correct / attempted * 100) : 0;
  });
  const attempted = correct + wrong;
  const accuracy = attempted ? Math.round(correct / attempted * 100) : 0;
  const now = Date.now();
  const result = {
    id: crypto.randomUUID(),
    roomCode: room.code,
    quizName: room.quizName,
    playerName: player.name,
    language: player.language,
    studentProfile: player.studentProfile || null,
    playerToken: player.token,
    correct, wrong, unanswered,
    attempted, accuracy, score: correct,
    total: room.questions.length,
    categories,
    guidance: guidanceFor({ ...Object.fromEntries(Object.entries(categories)), unanswered, wrong }, accuracy),
    submittedAt: new Date(now).toISOString(),
    durationSeconds: Math.max(0, Math.round((Math.min(now, room.endAt || now) - room.startAt) / 1000)),
    answers,
    performanceLevel: accuracy >= 85 ? 'Excellent' : accuracy >= 70 ? 'Strong' : accuracy >= 50 ? 'Developing' : 'Needs Foundation'
  };
  return result;
}
function finalizeRoom(room, reason = "time") {
  if (!room || room.ended) return;
  room.ended = true;
  room.started = false;
  room.endedAt = Date.now();
  for (const player of room.players.values()) {
    if (player.name === "Host") continue;
    if (!player.result) {
      player.result = calculateResult(room, player, { answers: player.answers || [] });
      player.result.endReason = reason;
    }
  }
  const history = readHistory();
  history.unshift({
    roomCode: room.code,
    hostToken: room.hostToken,
    quizName: room.quizName,
    maxPlayers: room.maxPlayers,
    startedAt: room.startAt ? new Date(room.startAt).toISOString() : null,
    endedAt: new Date(room.endedAt).toISOString(),
    endReason: reason,
    participants: [...room.players.values()]
      .filter(p => p.name !== "Host")
      .map(p => p.result)
      .filter(Boolean)
  });
  writeHistory(history.slice(0, 500));
  for (const player of room.players.values()) {
    if (player.result && player.socketId) io.to(player.socketId).emit("participantResult", player.result);
  }
  io.to(room.code).emit("quizEnded", { reason, endedAt: room.endedAt });
  io.to(room.code).emit("roomUpdated", publicRoom(room));
}
function scheduleRemoval(room, playerToken) {
  const player = [...room.players.values()].find(p => p.token === playerToken);
  if (!player) return;
  clearTimeout(player.removeTimer);
  player.removeTimer = setTimeout(() => {
    const current = [...room.players.values()].find(p => p.token === playerToken);
    if (!current || current.socketId) return;
    room.players.delete(current.id);
    io.to(room.code).emit("roomUpdated", publicRoom(room));
  }, RECONNECT_GRACE_MS);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/host-history", (req, res) => {
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Host token required." });
  const history = readHistory().filter(x => x.hostToken === token).map(({ hostToken, ...x }) => x);
  res.json(history);
});

io.on("connection", socket => {
  socket.on("createRoom", ({ quizName, maxPlayers, durationMinutes }) => {
    quizName = String(quizName || "").trim().slice(0, 60);
    maxPlayers = Math.max(1, Math.min(50, Number(maxPlayers) || 1));
    durationMinutes = Math.max(5, Math.min(180, Number(durationMinutes) || 45));
    if (!quizName) return socket.emit("roomError", "Please enter a quiz name.");
    const code = makeCode();
    const hostToken = makeToken();
    const room = {
      code, quizName, maxPlayers, durationMinutes, hostId: socket.id, hostToken,
      questions: selectRoomQuestions(code),
      started: false, ended: false, startAt: null, endAt: null, endedAt: null,
      players: new Map()
    };
    rooms.set(code, room);
    room.players.set(socket.id, { id: socket.id, socketId: socket.id, token: hostToken, name: "Host", language: "English", result: null, answers: [], removeTimer: null });
    socket.join(code);
    socket.data.roomCode = code; socket.data.sessionToken = hostToken; socket.data.isHost = true;
    socket.emit("roomCreated", { ...publicRoom(room), hostToken });
  });

  socket.on("joinRoom", ({ code, name, language, studentProfile }) => {
    code = String(code || "").trim();
    name = String(name || "").trim().slice(0, 30);
    language = language === "Hindi" ? "Hindi" : "English";
    const room = rooms.get(code);
    if (!room) return socket.emit("roomError", "Room not found. Check the code.");
    if (room.started || room.ended) return socket.emit("roomError", "This quiz is not accepting new participants.");
    if (!name) return socket.emit("roomError", "Please enter your name.");
    if ([...room.players.values()].filter(p => p.name !== "Host").length >= room.maxPlayers)
      return socket.emit("roomError", "This room is full.");
    const playerToken = makeToken();
    room.players.set(socket.id, { id: socket.id, socketId: socket.id, token: playerToken, name, language, studentProfile: studentProfile || null, result: null, answers: [], removeTimer: null });
    socket.join(code);
    socket.data.roomCode = code; socket.data.sessionToken = playerToken; socket.data.isHost = false;
    socket.emit("joinedRoom", { ...publicRoom(room), playerToken });
    io.to(code).emit("roomUpdated", publicRoom(room));
  });

  socket.on("claimSession", ({ code, token }) => {
    code = String(code || "").trim(); token = String(token || "").trim();
    const room = rooms.get(code);
    if (!room || !token) return socket.emit("sessionError", "Room session expired. Please create or join again.");
    if (token === room.hostToken) {
      room.hostId = socket.id;
      const old = [...room.players.values()].find(p => p.token === token);
      if (old) { clearTimeout(old.removeTimer); room.players.delete(old.id); }
      room.players.set(socket.id, { id: socket.id, socketId: socket.id, token, name: "Host", language: "English", result: null, answers: [], removeTimer: null });
      socket.join(code); socket.data.roomCode = code; socket.data.sessionToken = token; socket.data.isHost = true;
      socket.emit("sessionClaimed", { ...publicRoom(room), isHost: true });
      sendQuizState(socket, room, true);
      return;
    }
    const player = [...room.players.values()].find(p => p.token === token);
    if (!player) return socket.emit("sessionError", "Player session expired. Please join the room again.");
    clearTimeout(player.removeTimer);
    room.players.delete(player.id);
    player.id = socket.id; player.socketId = socket.id; player.removeTimer = null;
    room.players.set(socket.id, player);
    socket.join(code); socket.data.roomCode = code; socket.data.sessionToken = token; socket.data.isHost = false;
    socket.emit("sessionClaimed", { ...publicRoom(room), isHost: false });
    if (room.ended && player.result) socket.emit("participantResult", player.result);
    else sendQuizState(socket, room, false);
    io.to(code).emit("roomUpdated", publicRoom(room));
  });

  socket.on("startQuiz", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.id !== room.hostId || room.started || room.ended) return;
    room.started = true;
    room.startAt = Date.now();
    room.endAt = room.startAt + room.durationMinutes * 60 * 1000;
    io.to(room.code).emit("roomUpdated", publicRoom(room));
    io.to(room.code).emit("hostQuizStarted", {
      quizName: room.quizName, startAt: room.startAt, endAt: room.endAt, durationMinutes: room.durationMinutes
    });
    for (const player of room.players.values()) {
      if (player.name !== "Host" && player.socketId) {
        io.to(player.socketId).emit("quizStarted", {
          quizName: room.quizName, startAt: room.startAt, endAt: room.endAt, durationMinutes: room.durationMinutes,
          questions: room.questions.map(({answer, ...q}) => q)
        });
      }
    }
  });

  socket.on("endQuiz", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.id !== room.hostId) return;
    finalizeRoom(room, "host");
  });

  socket.on("saveProgress", ({ answers }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started || room.ended || socket.data.isHost) return;
    const player = [...room.players.values()].find(p => p.token === socket.data.sessionToken);
    if (!player || player.result) return;
    player.answers = Array.isArray(answers) ? answers.slice(0, room.questions.length) : [];
  });

  socket.on("submitQuiz", ({ answers }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started || room.ended || socket.data.isHost) return;
    const player = [...room.players.values()].find(p => p.token === socket.data.sessionToken);
    if (!player || player.result) return socket.emit("submitError", "Your result has already been submitted.");
    player.answers = Array.isArray(answers) ? answers.slice(0, room.questions.length) : [];
    player.result = calculateResult(room, player, { answers: player.answers });
    player.result.endReason = "submitted";
    socket.emit("participantResult", player.result);
    io.to(room.code).emit("roomUpdated", publicRoom(room));
    const participants = [...room.players.values()].filter(p => p.name !== "Host");
    if (participants.length && participants.every(p => p.result)) finalizeRoom(room, "all_submitted");
  });

  socket.on("requestHostHistory", () => {
    if (!socket.data.sessionToken || !socket.data.isHost) return;
    const history = readHistory().filter(x => x.hostToken === socket.data.sessionToken).map(({ hostToken, ...x }) => x);
    socket.emit("hostHistory", history);
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode, token = socket.data.sessionToken;
    if (!code || !token) return;
    const room = rooms.get(code);
    if (!room) return;
    const player = [...room.players.values()].find(p => p.token === token);
    if (!player) return;
    player.socketId = null;
    scheduleRemoval(room, token);
    io.to(code).emit("roomUpdated", publicRoom(room));
  });
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.started && room.endAt && now >= room.endAt) finalizeRoom(room, "time");
  }
}, 1000);

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`QuizX running on port ${PORT}`));
