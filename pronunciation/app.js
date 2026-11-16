// ═══════════════════════════════════════════════════════════
// 英語發音練習繳交系統 — 主程式
// 學生：免登入，輸入姓名即可繳交；老師：Google 登入
// ═══════════════════════════════════════════════════════════
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const cfg = window.APP_CONFIG || {};
const configured = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes("你的專案ID") && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.includes("你的anon");

if (!configured) {
  document.getElementById("config-warning").classList.remove("hidden");
}
const sb = configured
  ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
  : null;

// ── 狀態 ──
let mode = null; // 'student' | 'teacher'
let session = null; // 老師的登入 session
let profile = null; // 老師的 profile
let studentInfo = null; // { name, className, number }
let assignments = [];
let currentAssignment = null;
let currentRecording = null; // { blob, ext, source }
let mediaRecorder = null;
let recordTimer = null;
let recordSeconds = 0;
let teacherSubmissionsCache = [];

// ── DOM helpers ──
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ═══════════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════════
async function init() {
  if (!configured) return;
  bindEvents();

  // 有登入 session → 老師模式
  const { data: { session: s } } = await sb.auth.getSession();
  if (s) {
    session = s;
    mode = "teacher";
    await enterApp();
  } else {
    // 記住上次輸入的學生資料
    try {
      const saved = JSON.parse(localStorage.getItem("pron_student_info") || "null");
      if (saved?.name) {
        $("st-name").value = saved.name;
        $("st-class").value = saved.className || "";
        $("st-number").value = saved.number || "";
      }
    } catch (e) {}
  }
  sb.auth.onAuthStateChange(async (_event, s) => {
    session = s;
    if (s) {
      mode = "teacher";
      await enterApp();
    } else if (mode === "teacher") {
      showAuth();
    }
  });
}

function showAuth() {
  mode = null;
  profile = null;
  show($("view-auth"));
  hide($("view-app"));
}

async function enterApp() {
  hide($("view-auth"));
  show($("view-app"));
  if (mode === "teacher") await loadProfile();
  renderTopbar();
  switchTab("assignments");
  await loadAssignments();
  if (mode === "teacher") {
    await loadTeacherAssignments();
  }
}

async function loadProfile() {
  const user = session.user;
  let { data, error } = await sb.from("profiles").select("*").eq("id", user.id).single();
  if (error || !data) {
    // 沒有 profile 就建立一個（保險，正常會由 DB trigger 建立）
    const ins = await sb
      .from("profiles")
      .insert({
        id: user.id,
        email: user.email,
        full_name: user.user_metadata?.full_name || user.email,
      })
      .select()
      .single();
    data = ins.data;
  }
  profile = data;
}

function renderTopbar() {
  if (mode === "teacher") {
    $("user-name").textContent = "🧑‍🏫 " + (profile?.full_name || session?.user?.email || "老師");
    $("btn-signout").textContent = "登出";
  } else {
    const c = studentInfo?.className ? `（${studentInfo.className}${studentInfo.number ? " 號 " + studentInfo.number : ""}）` : "";
    $("user-name").textContent = "🎒 " + (studentInfo?.name || "") + c;
    $("btn-signout").textContent = "切換身分";
  }
  document.querySelectorAll(".tab.teacher-only").forEach((t) =>
    mode === "teacher" ? show(t) : hide(t)
  );
}

// ═══════════════════════════════════════════════════════════
// 事件綁定
// ═══════════════════════════════════════════════════════════
function bindEvents() {
  // 學生：輸入姓名進入
  $("btn-student-enter").addEventListener("click", enterAsStudent);
  $("st-name").addEventListener("keydown", (e) => { if (e.key === "Enter") enterAsStudent(); });

  // 老師：Google 登入
  $("btn-google-login").addEventListener("click", async () => {
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + window.location.pathname },
    });
    if (error) $("auth-error").textContent = "登入失敗：" + error.message;
  });

  // 登出 / 切換身分
  $("btn-signout").addEventListener("click", async () => {
    if (mode === "teacher") {
      await sb.auth.signOut();
      mode = null;
    }
    showAuth();
  });

  $("btn-back-list").addEventListener("click", () => {
    hide($("assignment-detail"));
    show($("assignment-list"));
    resetRecordUI();
  });

  // 分頁切換
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => switchTab(t.dataset.tab))
  );

  // 錄音
  $("btn-record").addEventListener("click", toggleRecord);
  $("file-input").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) setRecording(f, f.name.split(".").pop().toLowerCase(), "upload");
  });
  $("btn-submit").addEventListener("click", submitRecording);

  // 老師專區
  $("btn-create-assignment").addEventListener("click", createAssignment);
  $("teacher-assignment-select").addEventListener("change", () => renderTeacherSubmissions());
  $("btn-export-csv").addEventListener("click", exportCSV);
}

function enterAsStudent() {
  const name = $("st-name").value.trim();
  if (!name) {
    $("auth-error").textContent = "請先輸入你的名字再進入喔！";
    return;
  }
  $("auth-error").textContent = "";
  studentInfo = {
    name,
    className: $("st-class").value.trim(),
    number: $("st-number").value.trim(),
  };
  localStorage.setItem("pron_student_info", JSON.stringify(studentInfo));
  mode = "student";
  enterApp();
}

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === name)
  );
  document.querySelectorAll(".tab-panel").forEach((p) => hide(p));
  show($(`tab-${name}`));
  if (name === "history") loadHistory();
  if (name === "teacher") renderTeacherSubmissions();
}

// ═══════════════════════════════════════════════════════════
// 作業列表
// ═══════════════════════════════════════════════════════════
async function loadAssignments() {
  const { data, error } = await sb
    .from("assignments")
    .select("*")
    .eq("is_active", true)
    .order("created_at", { ascending: false });
  assignments = data || [];
  if (error) { $("assignment-list").innerHTML = `<p class="error-text">載入失敗：${esc(error.message)}</p>`; return; }
  if (!assignments.length) {
    $("assignment-list").innerHTML = `<div class="card">目前沒有作業，請等老師指派 📭</div>`;
    return;
  }
  $("assignment-list").innerHTML = assignments
    .map(
      (a) => `
    <div class="card">
      <h3>${esc(a.title)}</h3>
      <p class="auto-text">指派時間：${new Date(a.created_at).toLocaleString("zh-TW")}</p>
      <p class="auto-text">文本預覽：${esc(a.reference_text.slice(0, 80))}${a.reference_text.length > 80 ? "…" : ""}</p>
      <button class="btn btn-primary" onclick="window.__openAssignment('${a.id}')">開始練習 →</button>
    </div>`
    )
    .join("");
}

window.__openAssignment = (id) => {
  currentAssignment = assignments.find((a) => a.id === id);
  if (!currentAssignment) return;
  $("detail-title").textContent = currentAssignment.title;
  $("detail-text").textContent = currentAssignment.reference_text;
  hide($("assignment-list"));
  show($("assignment-detail"));
  hide($("result-card"));
  hide($("teacher-comment-view"));
  resetRecordUI();
  window.scrollTo(0, 0);
};

// ═══════════════════════════════════════════════════════════
// 錄音
// ═══════════════════════════════════════════════════════════
async function toggleRecord() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    let mimeType = "";
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) mimeType = "audio/webm;codecs=opus";
    else if (MediaRecorder.isTypeSupported("audio/mp4")) mimeType = "audio/mp4";
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(recordTimer);
      const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
      const ext = mimeType.includes("mp4") ? "m4a" : "webm";
      setRecording(blob, ext, "record");
      $("btn-record").textContent = "🔴 開始錄音";
      $("btn-record").classList.remove("recording");
      $("record-timer").textContent = "00:00";
    };
    mediaRecorder.start();
    $("btn-record").textContent = "⏹️ 停止錄音";
    $("btn-record").classList.add("recording");
    recordSeconds = 0;
    recordTimer = setInterval(() => {
      recordSeconds++;
      const m = String(Math.floor(recordSeconds / 60)).padStart(2, "0");
      const s = String(recordSeconds % 60).padStart(2, "0");
      $("record-timer").textContent = `${m}:${s}`;
    }, 1000);
  } catch (e) {
    alert("無法存取麥克風，請確認瀏覽器權限：" + e.message);
  }
}

function setRecording(blobOrFile, ext, source) {
  const blob = blobOrFile;
  currentRecording = { blob, ext, source };
  $("file-name").textContent =
    (source === "record" ? "已錄音" : "已選擇檔案") +
    `：${blob.name || "錄音." + ext}（${(blob.size / 1024).toFixed(0)} KB）`;
  const preview = $("preview-audio");
  preview.src = URL.createObjectURL(blob);
  show(preview);
  $("btn-submit").disabled = false;
}

function resetRecordUI() {
  currentRecording = null;
  $("file-name").textContent = "";
  hide($("preview-audio"));
  $("preview-audio").src = "";
  $("btn-submit").disabled = true;
  $("submit-status").textContent = "";
  $("file-input").value = "";
}

// ═══════════════════════════════════════════════════════════
// 繳交
// ═══════════════════════════════════════════════════════════
async function submitRecording() {
  if (!currentRecording || !currentAssignment) return;
  const statusEl = $("submit-status");
  statusEl.className = "";
  statusEl.textContent = "⏳ 上傳音檔中…";

  try {
    const { blob, ext } = currentRecording;
    const dateStr = new Date().toLocaleDateString("sv", { timeZone: "Asia/Taipei" });
    const who = mode === "student" ? studentInfo.name : (profile?.full_name || "teacher");
    const path = `anon/${currentAssignment.id}/${dateStr}/${encodeURIComponent(who)}-${Date.now()}.${ext}`;

    // 1. 上傳音檔（匿名允許上傳到 recordings/anon/ 底下）
    const { error: upErr } = await sb.storage
      .from("recordings")
      .upload(path, blob, { contentType: blob.type || "audio/webm", upsert: false });
    if (upErr) throw upErr;

    // 2. 建立繳交紀錄（免登入：記學生姓名）
    statusEl.textContent = "⏳ AI 發音分析中…（約需 10–30 秒）";
    const ins = await sb
      .from("submissions")
      .insert({
        assignment_id: currentAssignment.id,
        student_name: who,
        class_name: mode === "student" ? studentInfo.className : null,
        student_number: mode === "student" ? studentInfo.number : null,
        audio_path: path,
        submission_date: dateStr,
        status: "grading",
      })
      .select()
      .single();
    if (ins.error) throw ins.error;
    const sub = ins.data;

    // 3. 呼叫 Edge Function 分析（分數由伺服器寫回資料庫）
    const fd = new FormData();
    fd.append("audio", blob, `audio.${ext}`);
    fd.append("text", currentAssignment.reference_text);
    fd.append("submission_id", sub.id);
    const res = await fetch(`${cfg.SUPABASE_URL}/functions/v1/feedback`, {
      method: "POST",
      headers: {
        apikey: cfg.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}`,
      },
      body: fd,
    });
    const result = await res.json().catch(() => ({}));

    if (!res.ok) throw new Error(result.error || "分析失敗");

    statusEl.textContent = "✅ 繳交成功！";
    renderResult(result);
  } catch (e) {
    console.error(e);
    statusEl.className = "error";
    statusEl.textContent = "❌ " + (e.message || e) + "（老師仍可在「老師專區」聽你的音檔）";
  }
}

function renderResult(result) {
  $("score-value").textContent = result.score ?? "--";
  const words = result.words || [];
  const ok = result.okCount ?? words.filter((w) => w.status === "ok").length;
  const wrong = result.wrongCount ?? words.filter((w) => w.status === "wrong").length;
  const missed = result.missedCount ?? words.filter((w) => w.status === "missed").length;
  $("result-stats").innerHTML = `
    ✅ 正確 ${ok} 字<br>
    ⚠️ 待加強 ${wrong} 字<br>
    ❌ 漏讀 ${missed} 字<br>
    🗣️ 語速 ${result.fluency_wps ?? "--"} 字/秒`;
  $("result-words").innerHTML = words
    .map((w) => {
      const cls = w.status === "ok" ? "chip-ok" : w.status === "wrong" ? "chip-wrong" : "chip-missed";
      const tip = w.status === "wrong" && w.hyp ? ` title="AI 聽到：${esc(w.hyp)}"` : "";
      return `<span class="${cls}"${tip}>${esc(w.ref)}</span>`;
    })
    .join("");
  if (result.transcript) {
    show($("result-transcript-block"));
    $("result-transcript").textContent = result.transcript;
  }
  show($("result-card"));
  hide($("teacher-comment-view"));
  window.scrollTo(0, 0);
}

// ═══════════════════════════════════════════════════════════
// 我的紀錄
// ═══════════════════════════════════════════════════════════
function scoreBadgeClass(score) {
  if (score == null) return "score-none";
  if (score >= 85) return "score-high";
  if (score >= 60) return "score-mid";
  return "score-low";
}

async function signedUrl(path) {
  const { data } = await sb.storage.from("recordings").createSignedUrl(path, 3600);
  return data?.signedUrl;
}

async function loadHistory() {
  const listEl = $("history-list");
  listEl.innerHTML = "<p>載入中…</p>";

  let query = sb
    .from("submissions")
    .select("*, assignments(title)")
    .order("created_at", { ascending: false })
    .limit(100);

  if (mode === "student") {
    // 學生：用姓名（＋班級）查自己的紀錄
    query = query.eq("student_name", studentInfo.name);
    if (studentInfo.className) query = query.eq("class_name", studentInfo.className);
  } else {
    // 老師：看全部最近的繳交
    query = query.limit(50);
  }

  const { data, error } = await query;
  if (error) { listEl.innerHTML = `<p class="error-text">載入失敗：${esc(error.message)}</p>`; return; }
  if (!data.length) { listEl.innerHTML = `<div class="card">還沒有繳交紀錄 📭</div>`; return; }

  listEl.innerHTML = "";
  for (const s of data) {
    const div = document.createElement("div");
    div.className = "submission-item";
    // 老師可以聽音檔；學生（匿名）不開放
    const url = mode === "teacher" ? await signedUrl(s.audio_path) : null;
    const wd = s.words_detail || {};
    const wordsHtml = (wd.words || [])
      .map((w) => {
        const cls = w.status === "ok" ? "chip-ok" : w.status === "wrong" ? "chip-wrong" : "chip-missed";
        const tip = w.status === "wrong" && w.hyp ? ` title="AI 聽到：${esc(w.hyp)}"` : "";
        return `<span class="${cls}"${tip}>${esc(w.ref)}</span>`;
      })
      .join("");
    div.innerHTML = `
      ${mode === "teacher" ? `<strong>${esc(s.student_name || "未命名")}</strong>` : ""}
      <strong>${esc(s.assignments?.title || "作業")}</strong>
      <span class="score-badge ${scoreBadgeClass(s.accuracy_score)}">${s.accuracy_score != null ? s.accuracy_score + " 分" : s.status === "error" ? "分析失敗" : "分析中"}</span>
      <div class="meta">📅 ${esc(s.submission_date)}　🕒 ${new Date(s.created_at).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })}</div>
      ${url ? `<audio controls src="${url}"></audio>` : ""}
      ${wordsHtml ? `<div class="word-chips">${wordsHtml}</div>` : ""}
      ${s.status === "error" ? `<p class="error-text">分析失敗：${esc(s.error_message || "")}</p>` : ""}
      ${s.teacher_comment ? `<div class="teacher-comment-block">📝 老師回饋：${esc(s.teacher_comment)}</div>` : ""}
      ${s.teacher_score != null ? `<span class="score-badge score-high">老師評分 ${s.teacher_score}</span>` : ""}
    `;
    listEl.appendChild(div);
  }
}

// ═══════════════════════════════════════════════════════════
// 老師專區
// ═══════════════════════════════════════════════════════════
async function createAssignment() {
  const title = $("ta-title").value.trim();
  const text = $("ta-text").value.trim();
  const el = $("ta-status");
  if (!title || !text) {
    el.textContent = "請填寫標題和文本";
    el.className = "error-text";
    return;
  }
  const { error } = await sb.from("assignments").insert({
    teacher_id: session.user.id,
    title,
    reference_text: text,
  });
  if (error) { el.textContent = "❌ " + error.message; el.className = "error-text"; return; }
  el.textContent = "✅ 作業已建立";
  el.className = "";
  $("ta-title").value = "";
  $("ta-text").value = "";
  await loadAssignments();
  await loadTeacherAssignments();
  setTimeout(() => (el.textContent = ""), 3000);
}

async function loadTeacherAssignments() {
  const { data } = await sb.from("assignments").select("*").order("created_at", { ascending: false });
  const sel = $("teacher-assignment-select");
  sel.innerHTML =
    `<option value="">— 請選擇作業 —</option>` +
    (data || []).map((a) => `<option value="${a.id}">${esc(a.title)}</option>`).join("");
}

async function renderTeacherSubmissions() {
  const box = $("teacher-submissions");
  const aid = $("teacher-assignment-select").value;
  if (!aid) { box.innerHTML = `<p class="auto-text">請先選擇作業</p>`; teacherSubmissionsCache = []; return; }
  box.innerHTML = "<p>載入中…</p>";

  const { data, error } = await sb
    .from("submissions")
    .select("*, assignments(title)")
    .eq("assignment_id", aid)
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) { box.innerHTML = `<p class="error-text">載入失敗：${esc(error.message)}</p>`; return; }
  teacherSubmissionsCache = data || [];
  if (!teacherSubmissionsCache.length) { box.innerHTML = `<div class="card">這個作業還沒有人繳交 📭</div>`; return; }

  // 依學生分組（免登入模式：用姓名＋班級分組）
  const byStudent = {};
  for (const s of teacherSubmissionsCache) {
    const key = (s.student_name || "未命名") + "｜" + (s.class_name || "");
    (byStudent[key] ||= { label: key, subs: [] }).subs.push(s);
  }

  box.innerHTML = "";
  for (const [key, g] of Object.entries(byStudent)) {
    const stu = document.createElement("div");
    stu.className = "submission-item";
    const first = g.subs[0];
    stu.innerHTML = `
      <span class="stu-name">${esc(g.label)}</span>
      <span class="meta">${esc(first.student_number ? "座號 " + first.student_number : "")}</span>
      <div class="meta">共 ${g.subs.length} 次繳交</div>
    `;
    for (const s of g.subs) {
      const item = document.createElement("div");
      item.style.cssText = "border-top:1px solid var(--border); padding-top:10px; margin-top:10px;";
      const url = await signedUrl(s.audio_path);
      const wd = s.words_detail || {};
      const wordsHtml = (wd.words || [])
        .map((w) => {
          const cls = w.status === "ok" ? "chip-ok" : w.status === "wrong" ? "chip-wrong" : "chip-missed";
          return `<span class="${cls}">${esc(w.ref)}</span>`;
        })
        .join("");
      item.innerHTML = `
        <span class="score-badge ${scoreBadgeClass(s.accuracy_score)}">
          📅 ${esc(s.submission_date)}　${s.accuracy_score != null ? s.accuracy_score + " 分" : s.status === "error" ? "分析失敗" : "分析中"}
        </span>
        ${s.teacher_score != null ? `<span class="score-badge score-high">老師評分 ${s.teacher_score}</span>` : ""}
        ${url ? `<audio controls src="${url}"></audio>` : ""}
        ${wordsHtml ? `<div class="word-chips">${wordsHtml}</div>` : ""}
        ${s.transcript ? `<p class="auto-text">🤖 AI 聽到：${esc(s.transcript)}</p>` : ""}
        ${s.status === "error" ? `<p class="error-text">${esc(s.error_message || "")}</p>` : ""}
        <div class="teacher-comment-editor">
          <textarea data-comment="${s.id}" placeholder="輸入回饋給學生…">${esc(s.teacher_comment || "")}</textarea>
          <input type="number" min="0" max="100" data-tscore="${s.id}" value="${s.teacher_score ?? ""}" placeholder="評分" style="width:80px; padding:8px; border:1px solid var(--border); border-radius:8px;" />
          <button class="btn btn-primary btn-sm" data-save="${s.id}">儲存回饋</button>
        </div>
      `;
      stu.appendChild(item);
    }
    box.appendChild(stu);
  }

  // 儲存回饋事件
  box.querySelectorAll("[data-save]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const id = btn.dataset.save;
      const comment = box.querySelector(`[data-comment="${id}"]`).value.trim();
      const tsRaw = box.querySelector(`[data-tscore="${id}"]`).value;
      const { error } = await sb
        .from("submissions")
        .update({ teacher_comment: comment, teacher_score: tsRaw === "" ? null : Number(tsRaw) })
        .eq("id", id);
      btn.textContent = error ? "❌ 失敗" : "✅ 已儲存";
      setTimeout(() => (btn.textContent = "儲存回饋"), 2000);
    })
  );
}

function exportCSV() {
  if (!teacherSubmissionsCache.length) { alert("請先選擇作業"); return; }
  const rows = [["姓名", "班級", "座號", "作業", "繳交日期", "時間", "自動分數", "老師評分", "AI聽寫", "老師回饋"]];
  for (const s of teacherSubmissionsCache) {
    rows.push([
      s.student_name || "", s.class_name || "", s.student_number || "",
      s.assignments?.title || "", s.submission_date || "",
      new Date(s.created_at).toLocaleString("zh-TW"),
      s.accuracy_score ?? "", s.teacher_score ?? "",
      s.transcript || "", (s.teacher_comment || "").replace(/\n/g, " "),
    ]);
  }
  const csv = "\uFEFF" + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `繳交紀錄_${$("teacher-assignment-select").selectedOptions[0].text}.csv`;
  a.click();
}

// ═══════════════════════════════════════════════════════════
init();
