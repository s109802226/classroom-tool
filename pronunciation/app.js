// ═══════════════════════════════════════════════════════════
// 英語發音練習繳交系統 — 主程式
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
let session = null;
let profile = null;
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

  const { data: { session: s } } = await sb.auth.getSession();
  if (s) {
    session = s;
    await enterApp();
  }
  sb.auth.onAuthStateChange(async (_event, s) => {
    session = s;
    if (s) await enterApp();
    else showAuth();
  });
}

function showAuth() {
  show($("view-auth"));
  hide($("view-app"));
  profile = null;
}

async function enterApp() {
  hide($("view-auth"));
  show($("view-app"));
  await loadProfile();
  renderTopbar();
  switchTab("assignments");
  await loadAssignments();
  if (profile.role === "teacher") {
    show(document.querySelector(".tab.teacher-only"));
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
  $("user-name").textContent = profile.full_name || session.user.email;
  document.querySelectorAll(".tab.teacher-only").forEach((t) =>
    profile.role === "teacher" ? show(t) : hide(t)
  );
}

// ═══════════════════════════════════════════════════════════
// 事件綁定
// ═══════════════════════════════════════════════════════════
function bindEvents() {
  $("btn-google-login").addEventListener("click", async () => {
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + window.location.pathname },
    });
    if (error) $("auth-error").textContent = "登入失敗：" + error.message;
  });
  $("btn-signout").addEventListener("click", () => sb.auth.signOut());
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

  // 資料
  $("btn-save-profile").addEventListener("click", saveProfile);
  $("btn-create-assignment").addEventListener("click", createAssignment);
  $("teacher-assignment-select").addEventListener("change", () => renderTeacherSubmissions());
  $("btn-export-csv").addEventListener("click", exportCSV);
}

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === name)
  );
  document.querySelectorAll(".tab-panel").forEach((p) => hide(p));
  show($(`tab-${name}`));
  if (name === "history") loadHistory();
  if (name === "profile" && profile) {
    $("profile-name").value = profile.full_name || "";
    $("profile-class").value = profile.class_name || "";
    $("profile-number").value = profile.student_number || "";
  }
  if (name === "teacher") renderTeacherSubmissions();
}

// ═══════════════════════════════════════════════════════════
// 作業列表（學生）
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
  let sub = null;

  try {
    const { blob, ext } = currentRecording;
    const dateStr = new Date().toLocaleDateString("sv", { timeZone: "Asia/Taipei" });
    const path = `${session.user.id}/${currentAssignment.id}/${Date.now()}.${ext}`;

    // 1. 上傳音檔
    const { error: upErr } = await sb.storage
      .from("recordings")
      .upload(path, blob, { contentType: blob.type || "audio/webm", upsert: false });
    if (upErr) throw upErr;

    // 2. 建立繳交紀錄
    statusEl.textContent = "⏳ AI 發音分析中…（約需 10–30 秒）";
    const ins = await sb
      .from("submissions")
      .insert({
        assignment_id: currentAssignment.id,
        student_id: session.user.id,
        audio_path: path,
        submission_date: dateStr,
        status: "grading",
      })
      .select()
      .single();
    if (ins.error) throw ins.error;
    sub = ins.data;

    // 3. 呼叫 Edge Function 分析
    const fd = new FormData();
    fd.append("audio", blob, `audio.${ext}`);
    fd.append("text", currentAssignment.reference_text);
    const res = await fetch(`${cfg.SUPABASE_URL}/functions/v1/feedback`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: cfg.SUPABASE_ANON_KEY,
      },
      body: fd,
    });
    const result = await res.json().catch(() => ({}));

    if (!res.ok) throw new Error(result.error || "分析失敗");

    // 4. 回寫分析結果
    await sb
      .from("submissions")
      .update({
        status: "graded",
        transcript: result.transcript,
        accuracy_score: result.score,
        words_detail: { words: result.words, extras: result.extras },
        fluency_wps: result.fluency_wps,
      })
      .eq("id", sub.id);

    statusEl.textContent = "✅ 繳交成功！";
    renderResult(result);
  } catch (e) {
    console.error(e);
    statusEl.className = "error";
    statusEl.textContent = "❌ " + (e.message || e);
    // 分析失敗也要留下紀錄，讓老師可以聽音檔並手動回饋
    if (sub?.id) {
      await sb
        .from("submissions")
        .update({ status: "error", error_message: String(e.message || e).slice(0, 500) })
        .eq("id", sub.id);
    }
  }
}

function renderResult(result) {
  $("score-value").textContent = result.score ?? "--";
  const words = result.words || [];
  const ok = words.filter((w) => w.status === "ok").length;
  const wrong = words.filter((w) => w.status === "wrong").length;
  const missed = words.filter((w) => w.status === "missed").length;
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
  const { data, error } = await sb
    .from("submissions")
    .select("*, assignments(title)")
    .eq("student_id", session.user.id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) { listEl.innerHTML = `<p class="error-text">載入失敗：${esc(error.message)}</p>`; return; }
  if (!data.length) { listEl.innerHTML = `<div class="card">還沒有繳交紀錄 📭</div>`; return; }

  listEl.innerHTML = "";
  for (const s of data) {
    const div = document.createElement("div");
    div.className = "submission-item";
    const url = await signedUrl(s.audio_path);
    const wd = s.words_detail || {};
    const wordsHtml = (wd.words || [])
      .map((w) => {
        const cls = w.status === "ok" ? "chip-ok" : w.status === "wrong" ? "chip-wrong" : "chip-missed";
        const tip = w.status === "wrong" && w.hyp ? ` title="AI 聽到：${esc(w.hyp)}"` : "";
        return `<span class="${cls}"${tip}>${esc(w.ref)}</span>`;
      })
      .join("");
    div.innerHTML = `
      <strong>${esc(s.assignments?.title || "作業")}</strong>
      <span class="score-badge ${scoreBadgeClass(s.accuracy_score)}">${s.accuracy_score != null ? s.accuracy_score + " 分" : s.status === "error" ? "分析失敗" : "分析中"}</span>
      <div class="meta">📅 ${esc(s.submission_date)}　🕒 ${new Date(s.created_at).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })}</div>
      ${url ? `<audio controls src="${url}"></audio>` : ""}
      ${wordsHtml ? `<div class="word-chips">${wordsHtml}</div>` : ""}
      ${s.status === "error" ? `<p class="error-text">分析失敗：${esc(s.error_message || "")}</p>` : ""}
      ${s.teacher_comment ? `<div class="teacher-comment-block">📝 老師回饋：${esc(s.teacher_comment)}</div>` : ""}
    `;
    listEl.appendChild(div);
  }
}

// ═══════════════════════════════════════════════════════════
// 我的資料
// ═══════════════════════════════════════════════════════════
async function saveProfile() {
  const { error } = await sb
    .from("profiles")
    .update({
      full_name: $("profile-name").value.trim(),
      class_name: $("profile-class").value.trim(),
      student_number: $("profile-number").value.trim(),
    })
    .eq("id", session.user.id);
  const el = $("profile-status");
  if (error) { el.textContent = "❌ " + error.message; el.className = "error-text"; }
  else { el.textContent = "✅ 已儲存"; el.className = ""; renderTopbar(); }
  setTimeout(() => (el.textContent = ""), 3000);
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
    .select("*, assignments(title), profiles(full_name, email, class_name, student_number)")
    .eq("assignment_id", aid)
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) { box.innerHTML = `<p class="error-text">載入失敗：${esc(error.message)}</p>`; return; }
  teacherSubmissionsCache = data || [];
  if (!teacherSubmissionsCache.length) { box.innerHTML = `<div class="card">這個作業還沒有人繳交 📭</div>`; return; }

  // 依學生分組
  const byStudent = {};
  for (const s of teacherSubmissionsCache) {
    const key = s.student_id;
    (byStudent[key] ||= { p: s.profiles, subs: [] }).subs.push(s);
  }

  box.innerHTML = "";
  for (const [sid, g] of Object.entries(byStudent)) {
    const stu = document.createElement("div");
    stu.className = "submission-item";
    stu.innerHTML = `
      <span class="stu-name">${esc(g.p?.full_name || "未命名")}</span>
      <span class="meta">${esc(g.p?.class_name || "")} ${esc(g.p?.student_number || "")}｜${esc(g.p?.email || "")}</span>
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
  const rows = [["姓名", "班級", "座號", "Email", "作業", "繳交日期", "時間", "自動分數", "老師評分", "AI聽寫", "老師回饋"]];
  for (const s of teacherSubmissionsCache) {
    rows.push([
      s.profiles?.full_name || "", s.profiles?.class_name || "", s.profiles?.student_number || "",
      s.profiles?.email || "", s.assignments?.title || "", s.submission_date || "",
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
