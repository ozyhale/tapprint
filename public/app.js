/* global crypto */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = (data && data.error) || res.statusText || 'Request failed';
    const err = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function newRequestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `rid_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

const loginSection = document.getElementById('loginSection');
const jobsSection = document.getElementById('jobsSection');
const jobsList = document.getElementById('jobsList');
const emptyState = document.getElementById('emptyState');
const loginErr = document.getElementById('loginErr');
const toolbar = document.getElementById('toolbar');

let pollTimer = null;
let deleteTargetId = null;

async function refreshAuth() {
  try {
    await api('/api/me');
    showApp();
    return true;
  } catch {
    showLogin();
    return false;
  }
}

function showLogin() {
  loginSection.hidden = false;
  jobsSection.hidden = true;
  toolbar.hidden = true;
  stopPoll();
}

function showApp() {
  loginSection.hidden = true;
  jobsSection.hidden = false;
  toolbar.hidden = false;
  loadJobs();
  startPoll();
}

function stopPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(() => loadJobs(), 4000);
}

async function loadJobs() {
  try {
    const data = await api('/api/jobs');
    const jobs = data.jobs || [];
    renderJobs(jobs);
  } catch (e) {
    if (e.status === 401) showLogin();
  }
}

function renderJobs(jobs) {
  jobsList.innerHTML = '';
  emptyState.hidden = jobs.length > 0;

  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i];
    const card = el(`
      <article class="bg-card border border-border rounded-xl p-5 mb-4" data-job-id="${job.id}">
        <div class="font-semibold break-all mb-3">${escapeHtml(job.filename)}</div>
        <div class="text-[0.82rem] text-muted -mt-1.5 mb-2.5">
          ${job.created_at ? escapeHtml(new Date(job.created_at).toLocaleString()) : ''}
          ${job.sender_email ? ` &middot; ${escapeHtml(job.sender_email)}` : ''}
        </div>
        <div class="flex items-center gap-3 mb-4 text-muted text-[0.95rem]">
          <span>Copies</span>
          <button
            type="button"
            class="dec bg-secondary-btn text-text rounded-lg px-2.5 py-1.5 cursor-pointer"
            aria-label="Fewer copies"
          >&minus;</button>
          <span class="num min-w-9 text-center font-bold text-text text-[1.1rem]">${job.copies_default}</span>
          <button
            type="button"
            class="inc bg-secondary-btn text-text rounded-lg px-2.5 py-1.5 cursor-pointer"
            aria-label="More copies"
          >+</button>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <button
            type="button"
            class="print-bw bg-secondary-btn text-text rounded-[10px] px-3.5 py-2.5 cursor-pointer"
          >Print to Black</button>
          <button
            type="button"
            class="print-color bg-secondary-btn text-text rounded-[10px] px-3.5 py-2.5 cursor-pointer"
          >Print to Colored</button>
        </div>
        <div class="mt-2.5">
          <button
            type="button"
            class="del w-full bg-danger/20 text-danger border border-danger/40 rounded-[10px] px-3.5 py-2.5 cursor-pointer"
          >Delete the file</button>
        </div>
      </article>
    `);

    const numEl = card.querySelector('.num');
    let copies = Math.max(1, Math.min(99, Number(job.copies_default) || 2));

    function syncCopiesDisplay() {
      numEl.textContent = String(copies);
    }

    card.querySelector('.dec').addEventListener('click', async () => {
      copies = Math.max(1, copies - 1);
      syncCopiesDisplay();
      try {
        await api(`/api/jobs/${job.id}`, { method: 'PATCH', body: JSON.stringify({ copies }) });
      } catch {
        /* rollback optional */
      }
    });

    card.querySelector('.inc').addEventListener('click', async () => {
      copies = Math.min(99, copies + 1);
      syncCopiesDisplay();
      try {
        await api(`/api/jobs/${job.id}`, { method: 'PATCH', body: JSON.stringify({ copies }) });
      } catch {
        /* noop */
      }
    });

    async function doPrint(mode) {
      const btnBw = card.querySelector('.print-bw');
      const btnCo = card.querySelector('.print-color');
      const btns = [btnBw, btnCo, card.querySelector('.del'), card.querySelector('.dec'), card.querySelector('.inc')];
      btns.forEach((b) => {
        b.disabled = true;
      });
      const client_request_id = newRequestId();
      try {
        await api(`/api/jobs/${job.id}/print`, {
          method: 'POST',
          body: JSON.stringify({
            mode,
            copies,
            client_request_id,
          }),
        });
        await loadJobs();
      } catch (e) {
        alert(e.message || 'Print failed');
        btns.forEach((b) => {
          b.disabled = false;
        });
      }
    }

    card.querySelector('.print-bw').addEventListener('click', () => doPrint('bw'));
    card.querySelector('.print-color').addEventListener('click', () => doPrint('color'));

    card.querySelector('.del').addEventListener('click', () => {
      deleteTargetId = job.id;
      const modal = document.getElementById('confirmModal');
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    });

    jobsList.appendChild(card);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

document.getElementById('loginBtn').addEventListener('click', async () => {
  loginErr.hidden = true;
  const pin = document.getElementById('pinInput').value;
  try {
    await api('/login', { method: 'POST', body: JSON.stringify({ pin }) });
    document.getElementById('pinInput').value = '';
    showApp();
  } catch (e) {
    loginErr.textContent = e.message || 'Login failed';
    loginErr.hidden = false;
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  try {
    await api('/logout', { method: 'POST', body: '{}' });
  } catch {
    /* noop */
  }
  showLogin();
});

function closeConfirmModal() {
  const modal = document.getElementById('confirmModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

document.getElementById('confirmCancel').addEventListener('click', () => {
  deleteTargetId = null;
  closeConfirmModal();
});

document.getElementById('confirmOk').addEventListener('click', async () => {
  const id = deleteTargetId;
  closeConfirmModal();
  deleteTargetId = null;
  if (!id) return;
  try {
    await api(`/api/jobs/${id}`, { method: 'DELETE' });
    await loadJobs();
  } catch (e) {
    alert(e.message || 'Delete failed');
  }
});

refreshAuth();
